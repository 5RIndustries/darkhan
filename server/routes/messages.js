/**
 * DARYL — Message Routes
 * GET  /api/messages         — list messages (with channel, since, unread filters)
 * POST /api/messages         — send a message
 * GET  /api/messages/:id     — get single message
 *
 * Claude's primary polling endpoint:
 *   GET /api/messages?channel=chan_command&since=<ISO>&unread=true
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { requireAuth, getCurrentUserId, validateIdentity } = require('../middleware/auth');
const { onNewMessage } = require('../services/auto-responder');

// All message routes require auth
router.use(requireAuth);

// GET /api/messages
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const { channel, channel_id, since, limit, unread } = req.query;
  const channelFilter = channel_id || channel;  // Accept both parameter names

  let sql = 'SELECT * FROM messages WHERE 1=1';
  const params = [];

  if (channelFilter) {
    sql += ' AND channel_id = ?';
    params.push(channelFilter);
  }

  if (since) {
    sql += ' AND created_at > ?';
    params.push(since);
  }

  // Fetch newest messages first (DESC), then reverse to display in chronological order
  sql += ' ORDER BY created_at DESC';

  const queryLimit = Math.min(parseInt(limit) || 100, 500);
  sql += ' LIMIT ?';
  params.push(queryLimit);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Messages GET error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
    // Reverse to chronological order (oldest first) for display
    rows.reverse();
    // Parse metadata JSON where present
    const messages = rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      created_at_et: row.created_at ? new Date(row.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }) : null
    }));
    return res.json({ messages, count: messages.length });
  });
});

// GET /api/messages/:id
router.get('/:id', (req, res) => {
  const db = req.app.locals.db;
  db.get('SELECT * FROM messages WHERE id = ?', [req.params.id], (err, row) => {
    if (err) {
      console.error('Message GET by id error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Message not found' });
    }
    row.metadata = row.metadata ? JSON.parse(row.metadata) : null;
    return res.json(row);
  });
});

// POST /api/messages
router.post('/', async (req, res) => {
  const db = req.app.locals.db;
  const io = req.app.locals.io;

  // [DARKHAN SECURITY] Enforce identity — you are who you authenticated as, period.
  // No agent can post as a human. No human can post as a different human or agent.
  const identity = validateIdentity(req, req.body.from_user);
  const userId = identity.enforcedId || getCurrentUserId(req);

  if (req.body.from_user && !identity.valid) {
    console.warn(`[Security] Identity violation blocked: ${identity.reason}`);
    // Record for lockdown threshold
    const sec = req.app.locals.securityService;
    if (sec) sec.recordSecurityEvent('impersonations');
  }

  const {
    channel_id,
    body,
    priority = 'normal',
    type = 'message',
    reply_to = null,
    metadata = null
  } = req.body;

  // Validate required fields
  if (!channel_id || !body) {
    return res.status(400).json({ error: 'channel_id and body are required' });
  }

  // [DARKHAN SECURITY] LOCKDOWN CHECK — blocks all agent traffic when active
  const securityService = req.app.locals.securityService;
  if (securityService) {
    const lockdownCheck = securityService.checkLockdown(userId, req.authenticatedType);
    if (!lockdownCheck.allowed) {
      return res.status(403).json({
        error: 'LOCKDOWN ACTIVE',
        reason: lockdownCheck.reason,
        lockdown: securityService.getLockdownStatus(),
      });
    }
  }

  // [DARKHAN SECURITY] Scan incoming messages for prompt injection
  let securityMetadata = null;
  if (securityService) {
    // Determine origin: agents posting via API key are 'internal', web UI is 'internal',
    // messages containing forwarded content should be tagged 'external' by the sender
    const origin = (metadata && metadata.origin) || 'internal';
    const scan = securityService.sanitizeMessage(body, userId, origin);
    securityMetadata = scan.metadata;

    // If critical injection detected from external source, block and record for threshold
    if (!scan.metadata.injectionScan.safe && scan.metadata.injectionScan.severity === 'critical') {
      securityService.recordSecurityEvent('criticalInjections');
      return res.status(400).json({
        error: 'Message blocked by security scan',
        severity: scan.metadata.injectionScan.severity,
        lockdown: securityService.getLockdownStatus(),
      });
    }
  }

  const id = uuidv4();
  // Merge security metadata with any existing metadata
  const combinedMetadata = { ...(metadata || {}), ...(securityMetadata || {}) };

  // [DARKHAN CLAIM VERIFICATION] Verify agent claims before saving
  // Only agent messages get verified — humans can say whatever they want.
  const claimVerifier = req.app.locals.claimVerifier;
  if (claimVerifier && userId && userId.startsWith('agent_')) {
    try {
      const verification = await claimVerifier.verify(body, userId);
      if (verification) {
        combinedMetadata.claimVerification = verification;
      }
    } catch (cvErr) {
      console.warn('[ClaimVerifier] Verification error (non-blocking):', cvErr.message);
      // Non-blocking — if verification fails, message still goes through
    }
  }

  const metadataStr = JSON.stringify(combinedMetadata);

  db.run(
    `INSERT INTO messages (id, channel_id, from_user, body, priority, type, reply_to, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, channel_id, userId, body, priority, type, reply_to, metadataStr],
    function (err) {
      if (err) {
        console.error('Message POST error:', err.message);
        return res.status(500).json({ error: 'Failed to create message' });
      }

      const message = {
        id,
        channel_id,
        from_user: userId,
        body,
        priority,
        type,
        reply_to,
        metadata: metadata || null,
        created_at: new Date().toISOString(),
        created_at_et: new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false })
      };

      // Emit to WebSocket subscribers on this channel
      io.to(channel_id).emit('new_message', message);

      // Write trigger file for external integrations (bridge, health checks)
      const fs = require('fs');
      const triggerDir = require('path').join(__dirname, '../../..', 'Triggers');
      try {
        if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });
        const triggerFile = require('path').join(triggerDir, `msg_${id}.json`);
        fs.writeFileSync(triggerFile, JSON.stringify(message, null, 2), { mode: 0o600 });
      } catch (triggerErr) {
        console.warn('Trigger file write failed:', triggerErr.message);
      }

      // Trigger auto-responder with worker runtime context
      onNewMessage(message, {
        db,
        io: req.app.locals.io,
        workerRuntime: req.app.locals.workerRuntime,
      });

      return res.status(201).json({ ok: true, message });
    }
  );
});

module.exports = router;
