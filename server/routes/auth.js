/**
 * Darkhan — Auth Routes
 * POST /api/auth/login             — session login (web UI)
 * POST /api/auth/logout            — session logout
 * GET  /api/auth/me                — current user info
 * POST /api/auth/change-password   — change password (requires current pw)
 * POST /api/auth/generate-recovery — admin: generate a recovery token for a user
 * POST /api/auth/reset-with-token  — reset password using recovery token (no login required)
 */

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth, getCurrentUserId } = require('../middleware/auth');

// === BRUTE-FORCE PROTECTION ===
// [H-1 FIX] Track failed login attempts per IP+username. Exponential backoff.
// In-memory Map backed by SQLite for persistence across restarts.
const loginAttempts = new Map(); // key: "ip:username" -> { count, firstAttempt, lastAttempt }
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
let _bruteForceDb = null;

function _initBruteForceDb(db) {
  if (_bruteForceDb) return;
  _bruteForceDb = db;
  db.run(`CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY, count INTEGER, first_attempt INTEGER, last_attempt INTEGER
  )`);
  // Load persisted attempts into memory
  db.all('SELECT * FROM login_attempts', [], (err, rows) => {
    if (err) return;
    const now = Date.now();
    for (const row of rows || []) {
      if (now - row.first_attempt < ATTEMPT_WINDOW_MS) {
        loginAttempts.set(row.key, { count: row.count, firstAttempt: row.first_attempt, lastAttempt: row.last_attempt });
      } else {
        db.run('DELETE FROM login_attempts WHERE key = ?', [row.key]);
      }
    }
  });
}

function _persistAttempt(key, record) {
  if (!_bruteForceDb) return;
  _bruteForceDb.run(
    'INSERT OR REPLACE INTO login_attempts (key, count, first_attempt, last_attempt) VALUES (?, ?, ?, ?)',
    [key, record.count, record.firstAttempt, record.lastAttempt]
  );
}

function _clearAttempt(key) {
  loginAttempts.delete(key);
  if (_bruteForceDb) _bruteForceDb.run('DELETE FROM login_attempts WHERE key = ?', [key]);
}

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
    const newRecord = { count: 1, firstAttempt: now, lastAttempt: now };
    loginAttempts.set(key, newRecord);
    _persistAttempt(key, newRecord);
  } else {
    record.count++;
    record.lastAttempt = now;
    _persistAttempt(key, record);
  }

  // --- VPS Hardening: Also track per-IP across all usernames ---
  const ipKey = `iponly:${ip}`;
  const ipRecord = loginAttempts.get(ipKey);
  if (!ipRecord || (now - ipRecord.firstAttempt > ATTEMPT_WINDOW_MS)) {
    const newRecord = { count: 1, firstAttempt: now, lastAttempt: now };
    loginAttempts.set(ipKey, newRecord);
    _persistAttempt(ipKey, newRecord);
  } else {
    ipRecord.count++;
    ipRecord.lastAttempt = now;
    _persistAttempt(ipKey, ipRecord);
  }
}

// --- VPS Hardening: Per-IP rate limit (5 failures per 15 min across ALL usernames) ---
const IP_RATE_LIMIT = 5;
function _checkIpRateLimit(ip) {
  const ipKey = `iponly:${ip}`;
  const record = loginAttempts.get(ipKey);
  if (!record) return { blocked: false };

  const now = Date.now();
  if (now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(ipKey);
    return { blocked: false };
  }

  if (record.count >= IP_RATE_LIMIT) {
    const remainingMs = ATTEMPT_WINDOW_MS - (now - record.firstAttempt);
    return { blocked: true, remainingMinutes: Math.ceil(remainingMs / 60000) };
  }
  return { blocked: false };
}

function _clearLoginAttempts(ip, username) {
  _clearAttempt(`${ip}:${username}`);
}

// POST /api/auth/login
router.post('/login', (req, res) => {
  // [H-1 FIX] Initialize brute-force persistence on first login attempt
  _initBruteForceDb(req.app.locals.db);

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const activityLog = req.app.locals.activityLog;

  // VPS Hardening: Per-IP rate limit — blocks credential stuffing across usernames
  const ipCheck = _checkIpRateLimit(ip);
  if (ipCheck.blocked) {
    if (activityLog) {
      activityLog.append({ actor: 'darkhan_security', action: 'login_ip_ratelimited', target: ip, details: `IP blocked: too many failed attempts` });
    }
    return res.status(429).json({ error: `Too many login attempts from this address. Try again in ${ipCheck.remainingMinutes} minute(s).` });
  }

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
  // [M-4 FIX] Password complexity: min 8 chars + at least 3 of 4 categories
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const categories = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(r => r.test(newPassword)).length;
  if (categories < 3) {
    return res.status(400).json({ error: 'Password must contain at least 3 of: lowercase, uppercase, number, special character' });
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
  // [HARDENING-0d] Increased from 4 to 8 — 4-char PINs are brute-forceable against bcrypt
  if (!pin || pin.length < 8) {
    return res.status(400).json({ error: 'PIN must be at least 8 characters' });
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

// === PASSWORD RECOVERY ===
// Two-step: admin generates a token, user resets with token. No email required.
// Tokens are stored in secrets.db, expire in 1 hour, single-use.

// POST /api/auth/generate-recovery — admin generates a recovery token for a user
router.post('/generate-recovery', requireAuth, async (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can generate recovery tokens' });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const db = req.app.locals.db;
  const secretsDb = req.app.locals.secretsDb;
  const activityLog = req.app.locals.activityLog;
  if (!secretsDb) return res.status(500).json({ error: 'Credential store unavailable' });

  // Verify user exists
  const user = await new Promise((resolve, reject) =>
    db.get('SELECT id, username, type FROM users WHERE id = ?', [userId], (err, row) => {
      if (err) reject(err); else resolve(row);
    }));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.type !== 'human') return res.status(400).json({ error: 'Recovery tokens are for human users only' });

  // Generate token (readable format: 6 groups of 4 chars)
  const rawToken = crypto.randomBytes(18).toString('base64url');
  const token = rawToken.match(/.{1,4}/g).join('-');
  const tokenHash = await bcrypt.hash(token, 10);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  // Store in secrets.db (upsert: one active token per user)
  await new Promise((resolve, reject) =>
    secretsDb.run(
      `INSERT INTO secret_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`,
      [`recovery:${userId}`, JSON.stringify({ tokenHash, expiresAt, used: false }),
       JSON.stringify({ tokenHash, expiresAt, used: false })],
      (err) => { if (err) reject(err); else resolve(); }
    ));

  if (activityLog) {
    activityLog.append({
      actor: req.session.userId,
      action: 'recovery_token_generated',
      target: userId,
      details: JSON.stringify({ expiresAt }),
    });
  }

  console.log(`[Auth] Recovery token generated for ${userId} by ${req.session.userId}, expires ${expiresAt}`);
  res.json({ ok: true, token, expiresAt, userId: user.id, username: user.username });
});

// POST /api/auth/reset-with-token — reset password using recovery token (no login required)
router.post('/reset-with-token', async (req, res) => {
  const { username, token, newPassword } = req.body;
  if (!username || !token || !newPassword) {
    return res.status(400).json({ error: 'username, token, and newPassword required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const db = req.app.locals.db;
  const secretsDb = req.app.locals.secretsDb;
  const activityLog = req.app.locals.activityLog;
  if (!secretsDb) return res.status(500).json({ error: 'Credential store unavailable' });

  // Look up user by username
  const user = await new Promise((resolve, reject) =>
    db.get('SELECT id FROM users WHERE username = ? AND type = ?', [username, 'human'], (err, row) => {
      if (err) reject(err); else resolve(row);
    }));
  if (!user) return res.status(400).json({ error: 'Invalid recovery attempt' });

  // Look up recovery token
  const recoveryRow = await new Promise((resolve, reject) =>
    secretsDb.get('SELECT value FROM secret_settings WHERE key = ?', [`recovery:${user.id}`], (err, row) => {
      if (err) reject(err); else resolve(row);
    }));
  if (!recoveryRow) return res.status(400).json({ error: 'No recovery token found. Ask an admin to generate one.' });

  let recovery;
  try { recovery = JSON.parse(recoveryRow.value); } catch { return res.status(400).json({ error: 'Invalid recovery data' }); }

  // Check expiry
  if (new Date(recovery.expiresAt) < new Date()) {
    return res.status(400).json({ error: 'Recovery token expired. Ask an admin to generate a new one.' });
  }

  // Check if already used
  if (recovery.used) {
    return res.status(400).json({ error: 'Recovery token already used. Ask an admin to generate a new one.' });
  }

  // Verify token
  const valid = await bcrypt.compare(token, recovery.tokenHash);
  if (!valid) {
    if (activityLog) {
      activityLog.append({
        actor: 'anonymous',
        action: 'recovery_token_failed',
        target: user.id,
        details: JSON.stringify({ reason: 'invalid_token' }),
      });
    }
    return res.status(400).json({ error: 'Invalid recovery token' });
  }

  // Token valid — reset password
  const newHash = await bcrypt.hash(newPassword, 12);
  await new Promise((resolve, reject) =>
    secretsDb.run('UPDATE credentials SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [newHash, user.id], (err) => { if (err) reject(err); else resolve(); }));

  // Mark token as used
  recovery.used = true;
  await new Promise((resolve, reject) =>
    secretsDb.run('UPDATE secret_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
      [JSON.stringify(recovery), `recovery:${user.id}`], (err) => { if (err) reject(err); else resolve(); }));

  if (activityLog) {
    activityLog.append({
      actor: user.id,
      action: 'password_reset_via_token',
      target: user.id,
      details: JSON.stringify({ method: 'recovery_token' }),
    });
  }

  console.log(`[Auth] Password reset via recovery token for ${user.id}`);
  res.json({ ok: true, message: 'Password reset successfully. You can now log in.' });
});

// === EXECUTION TIER ===
// Per-user control over how much autonomy agents have.
// Three tiers:
//   supervised   — read-only without approval; all writes, restarts, external calls require approval
//   operational  — code edits, service restarts, file writes pre-approved; security actions still require approval
//   autonomous   — everything except hard security boundaries (credentials, auth, break-glass, admin ops)

const VALID_TIERS = ['supervised', 'operational', 'autonomous'];

// GET /api/auth/execution-tier — get current user's execution tier
router.get('/execution-tier', requireAuth, (req, res) => {
  const userId = getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const db = req.app.locals.db;
  db.get('SELECT execution_tier FROM users WHERE id = ?', [userId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json({ executionTier: row.execution_tier || 'supervised' });
  });
});

// POST /api/auth/execution-tier — set execution tier (human users only, for themselves)
router.post('/execution-tier', requireAuth, (req, res) => {
  // Only session-authenticated humans can change their own tier
  if (!req.session?.userId || req.session.userType !== 'human') {
    return res.status(403).json({ error: 'Only human users can set execution tier' });
  }

  const { tier } = req.body;
  if (!tier || !VALID_TIERS.includes(tier)) {
    return res.status(400).json({ error: `Invalid tier. Must be one of: ${VALID_TIERS.join(', ')}` });
  }

  const db = req.app.locals.db;
  const activityLog = req.app.locals.activityLog;
  const userId = req.session.userId;

  db.run('UPDATE users SET execution_tier = ? WHERE id = ?', [tier, userId], function (err) {
    if (err) return res.status(500).json({ error: err.message });

    if (activityLog) {
      activityLog.append({
        actor: userId,
        action: 'execution_tier_changed',
        target: userId,
        details: JSON.stringify({ tier }),
      });
    }

    console.log(`[Auth] Execution tier set to "${tier}" for ${userId}`);
    res.json({ ok: true, executionTier: tier });
  });
});

module.exports = router;
