/**
 * DARYL — Approval Queue Routes
 * 
 * GET  /api/approvals         — List approvals (filterable by status)
 * PATCH /api/approvals/:id    — Approve or deny (admin only)
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

// All routes require auth
router.use(requireAuth);

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

module.exports = router;
