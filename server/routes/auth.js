/**
 * DARYL — Auth Routes
 * POST /api/auth/login    — session login (web UI)
 * POST /api/auth/logout   — session logout
 * GET  /api/auth/me       — current user info
 */

const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const { requireAuth, getCurrentUserId } = require('../middleware/auth');

// === BRUTE-FORCE PROTECTION ===
// Track failed login attempts per IP+username. Exponential backoff.
// Does not persist across restarts (attacker would need to crash server to reset, which triggers lockdown).
const loginAttempts = new Map(); // key: "ip:username" -> { count, firstAttempt, lastAttempt }
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function _getLockoutMinutes(failCount) {
  if (failCount >= 15) return 15;
  if (failCount >= 10) return 5;
  if (failCount >= 5) return 1;
  return 0;
}

function _checkBruteForce(ip, username) {
  const key = `${ip}:${username}`;
  const record = loginAttempts.get(key);
  if (!record) return { blocked: false };

  const now = Date.now();

  // Prune stale records outside the window
  if (now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(key);
    return { blocked: false };
  }

  const lockoutMinutes = _getLockoutMinutes(record.count);
  if (lockoutMinutes === 0) return { blocked: false };

  const lockoutMs = lockoutMinutes * 60 * 1000;
  const timeSinceLastAttempt = now - record.lastAttempt;

  if (timeSinceLastAttempt < lockoutMs) {
    const remainingMs = lockoutMs - timeSinceLastAttempt;
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return { blocked: true, remainingMinutes, count: record.count };
  }

  return { blocked: false };
}

function _recordFailedLogin(ip, username) {
  const key = `${ip}:${username}`;
  const now = Date.now();
  const record = loginAttempts.get(key);

  if (!record || (now - record.firstAttempt > ATTEMPT_WINDOW_MS)) {
    loginAttempts.set(key, { count: 1, firstAttempt: now, lastAttempt: now });
  } else {
    record.count++;
    record.lastAttempt = now;
  }
}

function _clearLoginAttempts(ip, username) {
  const key = `${ip}:${username}`;
  loginAttempts.delete(key);
}

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const activityLog = req.app.locals.activityLog;

  // Check brute-force lockout BEFORE touching the database
  const bruteCheck = _checkBruteForce(ip, username);
  if (bruteCheck.blocked) {
    if (activityLog) {
      activityLog.append({
        actor: 'darkhan_security',
        action: 'login_rate_limited',
        target: username,
        details: JSON.stringify({ ip, attempts: bruteCheck.count, lockoutMinutes: bruteCheck.remainingMinutes }),
      });
    }
    return res.status(429).json({
      error: `Too many login attempts. Try again in ${bruteCheck.remainingMinutes} minute${bruteCheck.remainingMinutes !== 1 ? 's' : ''}.`,
    });
  }

  const db = req.app.locals.db;
  const secretsDb = req.app.locals.secretsDb;

  // Look up user by username (non-sensitive data from main DB)
  db.get(
    'SELECT id, username, role, timezone FROM users WHERE username = ?',
    [username],
    async (err, user) => {
      if (err) {
        console.error('Login DB error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!user) {
        _recordFailedLogin(ip, username);
        if (activityLog) {
          activityLog.append({
            actor: 'darkhan_security',
            action: 'login_failed',
            target: username,
            details: JSON.stringify({ ip, reason: 'unknown_user' }),
          });
        }
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      try {
        // SECURITY: Password hashes are stored ONLY in secrets.db — no fallback to darkhan.db
        let passwordHash = null;
        let mustChangePassword = false;

        if (!secretsDb) {
          return res.status(500).json({ error: 'Credential store unavailable' });
        }

        const cred = await new Promise((resolve, reject) => {
          secretsDb.get('SELECT password_hash, must_change_password FROM credentials WHERE user_id = ?', [user.id], (err2, row) => {
            if (err2) reject(err2); else resolve(row);
          });
        });
        if (cred) {
          passwordHash = cred.password_hash;
          mustChangePassword = cred.must_change_password === 1;
        }

        if (!passwordHash) {
          _recordFailedLogin(ip, username);
          return res.status(401).json({ error: 'Invalid credentials' });
        }

        const match = await bcrypt.compare(password, passwordHash);
        if (!match) {
          _recordFailedLogin(ip, username);
          if (activityLog) {
            activityLog.append({
              actor: 'darkhan_security',
              action: 'login_failed',
              target: username,
              details: JSON.stringify({ ip, reason: 'bad_password' }),
            });
          }
          return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Successful login — clear failed attempt counter
        _clearLoginAttempts(ip, username);

        // Set session — includes type for identity enforcement
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        req.session.userType = 'human'; // Only humans can login via web UI

        const response = {
          ok: true,
          user: { id: user.id, username: user.username, role: user.role, timezone: user.timezone || 'America/New_York' }
        };

        // Flag if the user must change their password before accessing the app
        if (mustChangePassword) {
          response.mustChangePassword = true;
        }

        return res.json(response);
      } catch (e) {
        console.error('Login bcrypt error:', e.message);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    return res.json({ ok: true });
  });
});

// GET /api/auth/me — returns current user info (session or API key)
router.get('/me', requireAuth, (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role
    });
  }
  if (req.user) {
    return res.json({
      id: req.user.id,
      username: req.user.username,
      role: req.user.role
    });
  }
  return res.status(401).json({ error: 'Not authenticated' });
});

// POST /api/auth/change-password — change password (session auth only, human admin)
router.post('/change-password', requireAuth, async (req, res) => {
  // Must be a session-authenticated human
  if (!req.session?.userId) {
    return res.status(403).json({ error: 'Password change requires web UI login' });
  }
  if (req.session.userType !== 'human') {
    return res.status(403).json({ error: 'Only human users can change passwords' });
  }

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const db = req.app.locals.db;
  const secretsDb = req.app.locals.secretsDb;
  const userId = req.session.userId;

  // SECURITY: Password hashes are stored ONLY in secrets.db — no fallback to darkhan.db
  let passwordHash = null;

  try {
    if (!secretsDb) {
      return res.status(500).json({ error: 'Credential store unavailable' });
    }

    const cred = await new Promise((resolve, reject) => {
      secretsDb.get('SELECT password_hash FROM credentials WHERE user_id = ?', [userId], (err, row) => {
        if (err) reject(err); else resolve(row);
      });
    });
    if (cred) {
      passwordHash = cred.password_hash;
    }

    if (!passwordHash) {
      return res.status(500).json({ error: 'Could not retrieve user credentials' });
    }

    const match = await bcrypt.compare(currentPassword, passwordHash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    // Update in secrets.db ONLY — no dual-write to darkhan.db
    // Also clear must_change_password flag so user is not prompted again.
    await new Promise((resolve, reject) => {
      secretsDb.run(
        `INSERT INTO credentials (user_id, password_hash, must_change_password) VALUES (?, ?, 0)
         ON CONFLICT(user_id) DO UPDATE SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP`,
        [userId, newHash, newHash],
        function (err) { if (err) reject(err); else resolve(this); }
      );
    });

    console.log(`[Auth] Password changed for ${userId} (must_change_password cleared)`);

    // Destroy ALL other sessions for this user (keep current session alive)
    // This prevents stale sessions from being used after a password change.
    const currentSid = req.sessionID;
    try {
      const sqlite3 = require('sqlite3').verbose();
      const sessionsDbPath = require('path').join(__dirname, '..', 'db', 'sessions.db');
      const sessDb = new sqlite3.Database(sessionsDbPath);
      sessDb.all('SELECT sid, sess FROM sessions', [], (err, rows) => {
        if (err || !rows) { sessDb.close(); return; }
        let destroyed = 0;
        for (const row of rows) {
          if (row.sid === currentSid) continue; // Keep current session
          try {
            const sessData = JSON.parse(row.sess);
            if (sessData.userId === userId) {
              sessDb.run('DELETE FROM sessions WHERE sid = ?', [row.sid]);
              destroyed++;
            }
          } catch (e) { /* invalid session data, skip */ }
        }
        if (destroyed > 0) {
          console.log(`[Auth] Destroyed ${destroyed} stale session(s) for ${userId} after password change`);
          if (activityLog) {
            activityLog.append({
              actor: userId,
              action: 'sessions_invalidated',
              target: userId,
              details: JSON.stringify({ count: destroyed, reason: 'password_change' }),
            });
          }
        }
        sessDb.close();
      });
    } catch (e) {
      console.warn('[Auth] Session cleanup after password change failed:', e.message);
    }

    return res.json({ ok: true, message: 'Password changed successfully' });
  } catch (e) {
    console.error('Password change error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/timezone — update user timezone preference
router.post('/timezone', requireAuth, (req, res) => {
  const { timezone } = req.body;
  if (!timezone) return res.status(400).json({ error: 'timezone required' });

  // Validate it's a real IANA timezone
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch (e) {
    return res.status(400).json({ error: `Invalid timezone: ${timezone}` });
  }

  const db = req.app.locals.db;
  db.run('UPDATE users SET timezone = ? WHERE id = ?', [timezone, req.session.userId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, timezone });
  });
});

// POST /api/auth/set-lockdown-pin — set/change the lockdown PIN (session auth, admin only)
// The PIN is required to unlock the system — even with session auth.
// This prevents agents who somehow get session access from unlocking.
router.post('/set-lockdown-pin', requireAuth, async (req, res) => {
  if (!req.session?.userId || req.session.userType !== 'human' || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Only human admins can set the lockdown PIN' });
  }

  const { pin } = req.body;
  if (!pin || pin.length < 4) {
    return res.status(400).json({ error: 'PIN must be at least 4 characters' });
  }

  const db = req.app.locals.db;
  const secretsDb = req.app.locals.secretsDb;
  const pinHash = await bcrypt.hash(pin, 12);

  // SECURITY: Store PIN hash in secrets.db ONLY — no dual-write to darkhan.db
  if (!secretsDb) {
    return res.status(500).json({ error: 'Credential store unavailable' });
  }

  secretsDb.run(
    `INSERT INTO secret_settings (key, value) VALUES ('lockdown_pin_hash', ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`,
    [pinHash, pinHash],
    function (err) {
      if (err) {
        console.error('[Auth] Failed to save PIN to secrets.db:', err.message);
        return res.status(500).json({ error: 'Failed to save PIN' });
      }
      console.log(`[Auth] Lockdown PIN set by ${req.session.userId}`);
      return res.json({ ok: true, message: 'Lockdown PIN set successfully' });
    }
  );
});

module.exports = router;
