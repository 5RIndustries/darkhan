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

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const db = req.app.locals.db;
  db.get(
    'SELECT id, username, password_hash, role FROM users WHERE username = ?',
    [username],
    async (err, user) => {
      if (err) {
        console.error('Login DB error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      try {
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Set session — includes type for identity enforcement
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        req.session.userType = 'human'; // Only humans can login via web UI

        return res.json({
          ok: true,
          user: { id: user.id, username: user.username, role: user.role }
        });
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
  const userId = req.session.userId;

  db.get('SELECT password_hash FROM users WHERE id = ?', [userId], async (err, user) => {
    if (err || !user) {
      return res.status(500).json({ error: 'Could not retrieve user' });
    }

    try {
      const match = await bcrypt.compare(currentPassword, user.password_hash);
      if (!match) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const newHash = await bcrypt.hash(newPassword, 12);
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId], function (updateErr) {
        if (updateErr) {
          return res.status(500).json({ error: 'Failed to update password' });
        }
        console.log(`[Auth] Password changed for ${userId}`);
        return res.json({ ok: true, message: 'Password changed successfully' });
      });
    } catch (e) {
      return res.status(500).json({ error: 'Internal server error' });
    }
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
  const pinHash = await bcrypt.hash(pin, 12);

  // Store PIN hash in a settings table
  db.run(
    `INSERT INTO settings (key, value) VALUES ('lockdown_pin_hash', ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`,
    [pinHash, pinHash],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to save PIN' });
      }
      console.log(`[Auth] Lockdown PIN set by ${req.session.userId}`);
      return res.json({ ok: true, message: 'Lockdown PIN set successfully' });
    }
  );
});

module.exports = router;
