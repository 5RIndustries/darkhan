/**
 * Darkhan — Approval Queue Routes
 *
 * POST /api/approvals           — Create a new approval request (agents via API key)
 * GET  /api/approvals           — List approvals (filterable by status)
 * POST /api/approvals/:id/approve — Approve (session auth, human admin only)
 * POST /api/approvals/:id/deny   — Deny (session auth, human admin only)
 * PATCH /api/approvals/:id      — Legacy approve/deny (admin only)
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

// All routes require auth
router.use(requireAuth);

/**
 * POST /api/approvals
 *
 * Create a new approval request. Agents call this to request permission
 * for sensitive actions.
 *
 * Request:
 *   {
 *     "requested_by": "agent_assistant",      — agent ID (optional; auto-filled from auth)
 *     "action_type": "send_email",           — type of action needing approval
 *     "action_detail": "Send email to ..."   — human-readable detail
 *   }
 *
 * Response:
 *   { "ok": true, "approval": { ... } }
 */
router.post('/', (req, res) => {
  const db = req.app.locals.db;
  const activityLog = req.app.locals.activityLog;
  const io = req.app.locals.io;

  const requestedBy = req.body.requested_by || req.user?.id || req.session?.userId || 'unknown';
  const { action_type, action_detail } = req.body;

  if (!action_type || !action_detail) {
    return res.status(400).json({ error: 'action_type and action_detail are required' });
  }

  const id = `appr_${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO approval_queue (id, requested_by, action_type, action_detail, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [id, requestedBy, action_type, action_detail, now],
    function (err) {
      if (err) {
        console.error('[approvals.js] INSERT error:', err.message);
        return res.status(500).json({ error: 'Failed to create approval request' });
      }

      console.log(`[approvals.js] New approval request ${id} from ${requestedBy}: ${action_type}`);

      if (activityLog) {
        activityLog.append({
          actor: requestedBy,
          action: 'approval_requested',
          target: id,
          details: JSON.stringify({ action_type, action_detail }),
        });
      }

      // Notify connected clients via WebSocket
      if (io) {
        io.emit('approval_update', { id, requested_by: requestedBy, action_type, action_detail, status: 'pending', created_at: now });
      }

      db.get('SELECT * FROM approval_queue WHERE id = ?', [id], (err2, row) => {
        if (err2) return res.status(500).json({ error: 'Created but failed to fetch' });
        return res.status(201).json({ ok: true, approval: row });
      });
    }
  );
});

/**
 * GET /api/approvals
 * 
 * Query params:
 *   ?status=pending      — filter by status ('pending', 'approved', 'denied')
 *   ?limit=50            — number of records (default 100)
 * 
 * Response:
 *   {
 *     "approvals": [
 *       {
 *         "id": "...",
 *         "requested_by": "claude-agent",
 *         "action_type": "file_write",
 *         "action_detail": "{...}",
 *         "status": "pending",
 *         "created_at": "...",
 *         "reviewed_by": null,
 *         "reviewed_at": null
 *       },
 *       ...
 *     ],
 *     "count": 1
 *   }
 */
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const { status, limit = 100 } = req.query;

  let sql = 'SELECT * FROM approval_queue WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  sql += ' ORDER BY created_at DESC';

  const queryLimit = Math.min(parseInt(limit) || 100, 500);
  sql += ' LIMIT ?';
  params.push(queryLimit);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('[approvals.js] GET error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }

    return res.json({
      approvals: rows || [],
      count: (rows || []).length
    });
  });
});

/**
 * PATCH /api/approvals/:id
 * 
 * Requires: admin role
 * 
 * Request:
 *   {
 *     "status": "approved",
 *     "reviewed_by": "admin"
 *   }
 * 
 * Response:
 *   {
 *     "ok": true,
 *     "approval": { ... updated record ... }
 *   }
 */
router.patch('/:id', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;
  const { status } = req.body;

  // Validate status
  if (!status || !['approved', 'denied'].includes(status)) {
    return res.status(400).json({ error: 'status must be "approved" or "denied"' });
  }

  // Get current approval to ensure it exists
  db.get('SELECT * FROM approval_queue WHERE id = ?', [id], (err, approval) => {
    if (err) {
      console.error('[approvals.js] GET error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!approval) {
      return res.status(404).json({ error: 'Approval not found' });
    }

    // Update approval
    const now = new Date().toISOString();
    const reviewedBy = req.session?.userId || req.user?.id || 'unknown';

    db.run(
      `UPDATE approval_queue SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`,
      [status, reviewedBy, now, id],
      function (err) {
        if (err) {
          console.error('[approvals.js] UPDATE error:', err.message);
          return res.status(500).json({ error: 'Failed to update approval' });
        }

        console.log(`[approvals.js] Approval ${id} marked as ${status} by ${reviewedBy}`);

        // Re-fetch the updated record
        db.get('SELECT * FROM approval_queue WHERE id = ?', [id], (err, updated) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to fetch updated approval' });
          }

          return res.json({
            ok: true,
            approval: updated
          });
        });
      }
    );
  });
});

/**
 * POST /api/approvals/:id/approve
 *
 * Approve an approval request. Requires browser session auth (human admin only).
 * API key auth is rejected — agents must not approve their own requests.
 */
router.post('/:id/approve', (req, res) => {
  if (!req.session?.userId) {
    return res.status(403).json({ error: 'Approval requires web UI login (session auth)' });
  }
  const userType = req.session.userType || 'unknown';
  if (userType !== 'human') {
    return res.status(403).json({ error: 'Only human admins can approve requests' });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Only admin users can approve requests' });
  }

  _resolveApproval(req, res, 'approved');
});

/**
 * POST /api/approvals/:id/deny
 *
 * Deny an approval request. Requires browser session auth (human admin only).
 */
router.post('/:id/deny', (req, res) => {
  if (!req.session?.userId) {
    return res.status(403).json({ error: 'Denial requires web UI login (session auth)' });
  }
  const userType = req.session.userType || 'unknown';
  if (userType !== 'human') {
    return res.status(403).json({ error: 'Only human admins can deny requests' });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Only admin users can deny requests' });
  }

  _resolveApproval(req, res, 'denied');
});

/**
 * Shared helper: resolve an approval request (approve or deny).
 */
function _resolveApproval(req, res, newStatus) {
  const db = req.app.locals.db;
  const activityLog = req.app.locals.activityLog;
  const io = req.app.locals.io;
  const { id } = req.params;
  const reviewedBy = req.session.userId;

  db.get('SELECT * FROM approval_queue WHERE id = ?', [id], (err, approval) => {
    if (err) {
      console.error('[approvals.js] GET error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!approval) {
      return res.status(404).json({ error: 'Approval not found' });
    }
    if (approval.status !== 'pending') {
      return res.status(400).json({ error: `Approval already ${approval.status}` });
    }

    const now = new Date().toISOString();
    db.run(
      'UPDATE approval_queue SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
      [newStatus, reviewedBy, now, id],
      function (err2) {
        if (err2) {
          console.error('[approvals.js] UPDATE error:', err2.message);
          return res.status(500).json({ error: 'Failed to update approval' });
        }

        console.log(`[approvals.js] Approval ${id} ${newStatus} by ${reviewedBy}`);

        if (activityLog) {
          activityLog.append({
            actor: reviewedBy,
            action: `approval_${newStatus}`,
            target: id,
            details: JSON.stringify({ action_type: approval.action_type, requested_by: approval.requested_by }),
          });
        }

        // Notify connected clients
        if (io) {
          io.emit('approval_update', { id, status: newStatus, reviewed_by: reviewedBy, reviewed_at: now });
        }

        db.get('SELECT * FROM approval_queue WHERE id = ?', [id], (err3, updated) => {
          if (err3) return res.status(500).json({ error: 'Updated but failed to fetch' });
          return res.json({ ok: true, approval: updated });
        });
      }
    );
  });
}

module.exports = router;
