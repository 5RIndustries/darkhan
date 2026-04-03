/**
 * Darkhan — Task Routes
 * GET    /api/tasks          — list tasks (with status, assignee filters)
 * POST   /api/tasks          — create a task
 * GET    /api/tasks/:id      — get single task
 * PATCH  /api/tasks/:id      — update task (status, priority, assignee)
 * DELETE /api/tasks/:id      — delete task (admin only)
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth, requireAdmin, getCurrentUserId } = require('../middleware/auth');

// All task routes require auth
router.use(requireAuth);

// GET /api/tasks
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const { status, assignee, priority, limit } = req.query;

  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (assignee) {
    sql += ' AND assignee = ?';
    params.push(assignee);
  }
  if (priority) {
    sql += ' AND priority = ?';
    params.push(parseInt(priority));
  }

  sql += ' ORDER BY priority ASC, created_at DESC';

  const queryLimit = Math.min(parseInt(limit) || 50, 200);
  sql += ' LIMIT ?';
  params.push(queryLimit);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Tasks GET error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.json({ tasks: rows, count: rows.length });
  });
});

// GET /api/tasks/:id
router.get('/:id', (req, res) => {
  const db = req.app.locals.db;
  db.get('SELECT * FROM tasks WHERE id = ?', [req.params.id], (err, row) => {
    if (err) {
      console.error('Task GET by id error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Task not found' });
    }
    return res.json(row);
  });
});

// POST /api/tasks
router.post('/', (req, res) => {
  const db = req.app.locals.db;
  const io = req.app.locals.io;
  const userId = getCurrentUserId(req);

  const {
    title,
    description = null,
    assignee,
    priority = 3,
    folio_path = null
  } = req.body;

  if (!title || !assignee) {
    return res.status(400).json({ error: 'title and assignee are required' });
  }

  const id = crypto.randomUUID();

  db.run(
    `INSERT INTO tasks (id, title, description, assignee, created_by, priority, folio_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, title, description, assignee, userId, priority, folio_path],
    function (err) {
      if (err) {
        console.error('Task POST error:', err.message);
        return res.status(500).json({ error: 'Failed to create task' });
      }

      const task = {
        id,
        title,
        description,
        assignee,
        created_by: userId,
        status: 'queued',
        priority,
        folio_path,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // Notify via WebSocket
      io.emit('task_update', { action: 'created', task });

      return res.status(201).json({ ok: true, task });
    }
  );
});

// PATCH /api/tasks/:id
router.patch('/:id', (req, res) => {
  const db = req.app.locals.db;
  const io = req.app.locals.io;

  const allowedFields = ['status', 'priority', 'assignee', 'description', 'folio_path'];
  const updates = [];
  const params = [];

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      params.push(req.body[field]);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);

  db.run(
    `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`,
    params,
    function (err) {
      if (err) {
        console.error('Task PATCH error:', err.message);
        return res.status(500).json({ error: 'Failed to update task' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Task not found' });
      }

      // Fetch updated task and broadcast
      db.get('SELECT * FROM tasks WHERE id = ?', [req.params.id], (err2, row) => {
        if (row) {
          io.emit('task_update', { action: 'updated', task: row });
        }
        return res.json({ ok: true, task: row });
      });
    }
  );
});

// DELETE /api/tasks/:id (admin only)
router.delete('/:id', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const io = req.app.locals.io;

  db.run('DELETE FROM tasks WHERE id = ?', [req.params.id], function (err) {
    if (err) {
      console.error('Task DELETE error:', err.message);
      return res.status(500).json({ error: 'Failed to delete task' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    io.emit('task_update', { action: 'deleted', taskId: req.params.id });
    return res.json({ ok: true });
  });
});

module.exports = router;
