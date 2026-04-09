/**
 * Darkhan — Quarantine Queue Routes
 *
 * [MYTHOS DEFENSE] When the two-LLM consensus disagrees on a message's safety,
 * the message is quarantined for human review. This queue allows admins to:
 *   - View quarantined messages with their consensus results
 *   - Approve (release to the target channel) or reject (discard)
 *   - Approve/reject decisions feed back into the classification training data
 *
 * POST /api/quarantine              — Quarantine a message (internal, from security service)
 * GET  /api/quarantine              — List quarantined messages (admin only)
 * POST /api/quarantine/:id/approve  — Release message to channel (admin only)
 * POST /api/quarantine/:id/reject   — Discard message (admin only)
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

/**
 * POST /api/quarantine — Quarantine a message
 * Called internally by the security pipeline when consensus disagrees.
 */
router.post('/', (req, res) => {
  const db = req.app.locals.db;
  const activityLog = req.app.locals.activityLog;

  const {
    original_channel, from_user, body, priority, type,
    local_verdict, cloud_verdict, consensus, metadata
  } = req.body;

  if (!body || !from_user) {
    return res.status(400).json({ error: 'body and from_user are required' });
  }

  const id = `quar_${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO quarantine_queue (id, original_channel, from_user, body, priority, type,
     local_verdict, cloud_verdict, consensus, metadata, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [id, original_channel || 'chan_coordination', from_user, body, priority || 'normal',
     type || 'message', local_verdict, cloud_verdict, consensus, JSON.stringify(metadata || {}), now],
    function (err) {
      if (err) {
        console.error('[Quarantine] Insert error:', err.message);
        return res.status(500).json({ error: 'Failed to quarantine message' });
      }

      if (activityLog) {
        activityLog.append({
          actor: 'darkhan_security',
          action: 'message_quarantined',
          target: from_user,
          details: JSON.stringify({ id, local_verdict, cloud_verdict, consensus }),
        });
      }

      // Notify via Socket.IO
      const io = req.app.locals.io;
      if (io) {
        io.to('chan_alerts').emit('new_message', {
          id: crypto.randomUUID(), channel_id: 'chan_alerts', from_user: 'darkhan_security',
          body: `[QUARANTINE] Message from ${from_user} quarantined — LLM consensus disagreement (local: ${local_verdict}, cloud: ${cloud_verdict}). Review in Quarantine queue.`,
          priority: 'high', type: 'alert', created_at: now,
        });
      }

      res.status(201).json({ ok: true, quarantine: { id, status: 'pending' } });
    }
  );
});

/**
 * GET /api/quarantine — List quarantined messages
 */
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const status = req.query.status || 'pending';

  db.all(
    `SELECT * FROM quarantine_queue WHERE status = ? ORDER BY created_at DESC LIMIT 50`,
    [status],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ quarantined: rows || [] });
    }
  );
});

/**
 * POST /api/quarantine/:id/approve — Release message to channel
 */
router.post('/:id/approve', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const io = req.app.locals.io;
  const activityLog = req.app.locals.activityLog;
  const instanceIdentity = req.app.locals.instanceIdentity;
  const quarantineId = req.params.id;

  db.get('SELECT * FROM quarantine_queue WHERE id = ? AND status = ?', [quarantineId, 'pending'], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Quarantined message not found or already reviewed' });

    // Release: insert the message into the actual messages table
    const msgId = crypto.randomUUID();
    const trustLevel = 'human_verified'; // Admin approved = highest trust
    const signature = instanceIdentity ? instanceIdentity.sign(msgId, row.from_user, row.body, trustLevel) : null;
    const metadata = JSON.stringify({
      ...JSON.parse(row.metadata || '{}'),
      quarantine: { id: quarantineId, approved_by: req.session.userId, approved_at: new Date().toISOString() },
    });

    db.run(
      `INSERT INTO messages (id, channel_id, from_user, body, priority, type, trust_level, metadata, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [msgId, row.original_channel, row.from_user, row.body, row.priority, row.type, trustLevel, metadata, signature],
      (insertErr) => {
        if (insertErr) return res.status(500).json({ error: 'Failed to release message' });

        // Update quarantine status
        db.run('UPDATE quarantine_queue SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
          ['approved', req.session.userId, new Date().toISOString(), quarantineId]);

        // Emit the message to the channel
        if (io) {
          io.to(row.original_channel).emit('new_message', {
            id: msgId, channel_id: row.original_channel, from_user: row.from_user,
            body: row.body, priority: row.priority, type: row.type,
            trust_level: trustLevel, created_at: new Date().toISOString(),
          });
        }

        if (activityLog) {
          activityLog.append({
            actor: req.session.userId,
            action: 'quarantine_approved',
            target: quarantineId,
            details: JSON.stringify({ from_user: row.from_user, channel: row.original_channel }),
          });
        }

        // Log as training data — human approved this as safe
        db.run(
          `INSERT INTO triage_log (message_hash, message_length, from_user_type, channel_id, classification, model_name, model_version)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [require('crypto').createHash('sha256').update(row.body).digest('hex'),
           row.body.length, 'quarantine_approved', row.original_channel, 'safe_human_verified',
           'human_review', 'admin']);

        res.json({ ok: true, released: msgId });
      }
    );
  });
});

/**
 * POST /api/quarantine/:id/reject — Discard message
 */
router.post('/:id/reject', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const activityLog = req.app.locals.activityLog;
  const quarantineId = req.params.id;

  db.get('SELECT * FROM quarantine_queue WHERE id = ? AND status = ?', [quarantineId, 'pending'], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Quarantined message not found or already reviewed' });

    db.run('UPDATE quarantine_queue SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
      ['rejected', req.session.userId, new Date().toISOString(), quarantineId]);

    if (activityLog) {
      activityLog.append({
        actor: req.session.userId,
        action: 'quarantine_rejected',
        target: quarantineId,
        details: JSON.stringify({ from_user: row.from_user, reason: req.body.reason || 'admin rejected' }),
      });
    }

    // Log as training data — human rejected this as threat
    db.run(
      `INSERT INTO triage_log (message_hash, message_length, from_user_type, channel_id, classification, model_name, model_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [require('crypto').createHash('sha256').update(row.body).digest('hex'),
       row.body.length, 'quarantine_rejected', row.original_channel, 'threat_human_verified',
       'human_review', 'admin']);

    res.json({ ok: true, rejected: quarantineId });
  });
});

module.exports = router;
