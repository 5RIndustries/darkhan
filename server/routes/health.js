/**
 * DARYL — Agent Health Routes
 * GET  /api/health/agents         — list agent health status
 * POST /api/health/agents         — post agent health update
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/health/agents — Claude's dashboard endpoint
router.get('/agents', (req, res) => {
  const db = req.app.locals.db;
  const { agent } = req.query;

  // Get the most recent health entry per agent
  let sql = `
    SELECT ah.* FROM agent_health ah
    INNER JOIN (
      SELECT agent, MAX(checked_at) as max_checked
      FROM agent_health
      ${agent ? 'WHERE agent = ?' : ''}
      GROUP BY agent
    ) latest ON ah.agent = latest.agent AND ah.checked_at = latest.max_checked
    ORDER BY ah.agent
  `;
  const params = agent ? [agent] : [];

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Health GET error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
    return res.json({ agents: rows });
  });
});

// POST /api/health/agents — health check scripts and agents report status
router.post('/agents', (req, res) => {
  const db = req.app.locals.db;
  const io = req.app.locals.io;

  const { agent, status, details = null } = req.body;

  if (!agent || !status) {
    return res.status(400).json({ error: 'agent and status are required' });
  }

  const validStatuses = ['healthy', 'down', 'restarting', 'idle', 'busy'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  db.run(
    'INSERT INTO agent_health (agent, status, details) VALUES (?, ?, ?)',
    [agent, status, details],
    function (err) {
      if (err) {
        console.error('Health POST error:', err.message);
        return res.status(500).json({ error: 'Failed to record health status' });
      }

      const entry = { id: this.lastID, agent, status, details, checked_at: new Date().toISOString() };
      io.emit('agent_health', entry);
      return res.status(201).json({ ok: true, entry });
    }
  );
});

// POST /api/health/ping — agents call this every 30s to say "I'm alive"
// Uses the authenticated agent ID from the API key — no body-supplied agent override
router.post('/ping', (req, res) => {
  const db = req.app.locals.db;
  const { getCurrentUserId } = require('../middleware/auth');
  const agent = getCurrentUserId(req);
  const { status = 'active' } = req.body;

  if (!agent) {
    return res.status(401).json({ error: 'Could not determine agent identity from authentication' });
  }

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO agent_heartbeats (agent, status, last_ping_at)
     VALUES (?, ?, ?)
     ON CONFLICT(agent) DO UPDATE SET status = ?, last_ping_at = ?`,
    [agent, status, now, status, now],
    function (err) {
      if (err) {
        console.error('Ping error:', err.message);
        return res.status(500).json({ error: 'Failed to record ping' });
      }
      return res.json({ ok: true, agent, status, pinged_at: now });
    }
  );
});

// GET /api/health/status — dashboard status lights (Green/Amber/Red)
router.get('/status', (req, res) => {
  const db = req.app.locals.db;
  const GREEN = 5 * 60 * 1000;
  const AMBER = 30 * 60 * 1000;
  const now = Date.now();

  db.all('SELECT * FROM agent_heartbeats', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Internal server error' });
    }

    // Helper: parse timestamps that may or may not have 'Z' suffix
    const parseTs = (ts) => {
      if (!ts) return 0;
      const normalized = ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z';
      const result = new Date(normalized).getTime();
      return isNaN(result) ? 0 : result;
    };

    const agents = (rows || []).map(r => {
      const lastPing = parseTs(r.last_ping_at);
      const lastMsg = parseTs(r.last_message_at);
      const lastActivity = Math.max(lastPing, lastMsg);
      const age = lastActivity ? now - lastActivity : Infinity;

      let color = 'red';
      if (age < GREEN) color = 'green';
      else if (age < AMBER) color = 'amber';

      return {
        agent: r.agent,
        color,
        status: r.status,
        last_ping_at: r.last_ping_at,
        last_message_at: r.last_message_at,
        seconds_ago: lastActivity ? Math.round(age / 1000) : null
      };
    });

    return res.json({ agents, checked_at: new Date().toISOString() });
  });
});

module.exports = router;
