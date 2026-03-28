/**
 * DEPRECATED — 2026-03-27
 *
 * Legacy route for direct Anthropic API calls. Replaced by the auto-responder
 * (local LLM + Claude CLI relay). Kept for reference. Safe to delete.
 *
 * POST /api/claude/message   — Send message to Claude (triggers API call)
 * GET  /api/claude/conversations — Get conversation history
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { sendMessage } = require('../services/claude-api');

// All routes require auth
router.use(requireAuth);

/**
 * POST /api/claude/message
 * 
 * Request:
 *   {
 *     "channel_id": "chan_command",
 *     "message": "What are the current blockers?"
 *   }
 * 
 * Response:
 *   {
 *     "ok": true,
 *     "response": "Here are the blockers...",
 *     "token_usage": { "input": 1234, "output": 567, "total": 1801 }
 *   }
 */
router.post('/message', async (req, res) => {
  try {
    const { channel_id, message } = req.body;
    const db = req.app.locals.db;
    const io = req.app.locals.io;

    if (!channel_id || !message) {
      return res.status(400).json({ error: 'channel_id and message are required' });
    }

    // Call Claude API
    const result = await sendMessage(channel_id, message, { db, io });

    // Post Claude's text response to the channel so it appears in chat
    if (result.response) {
      const { v4: uuidv4 } = require('uuid');
      const msgId = uuidv4();
      db.run(
        'INSERT INTO messages (id, channel_id, from_user, body, priority, type) VALUES (?, ?, ?, ?, ?, ?)',
        [msgId, channel_id, 'agent_darkhan', result.response, 'normal', 'message'],
        (err) => {
          if (!err && io) {
            io.to(channel_id).emit('new_message', {
              id: msgId, channel_id, from_user: 'agent_darkhan',
              body: result.response, type: 'message',
              created_at: new Date().toISOString()
            });
          }
        }
      );
    }

    return res.json({
      ok: true,
      response: result.response,
      tool_calls: result.toolCalls,
      token_usage: result.tokenUsage
    });
  } catch (err) {
    console.error('[claude.js] POST /message error:', err.message);
    return res.status(500).json({
      error: 'Failed to send message to Claude',
      details: err.message
    });
  }
});

/**
 * GET /api/claude/conversations
 * 
 * Query params:
 *   ?channel=chan_command     — filter by channel
 *   ?limit=50                 — number of messages (default 100, max 500)
 * 
 * Response:
 *   {
 *     "messages": [
 *       { "id": "...", "channel_id": "...", "role": "user", "content": "...", "created_at": "..." },
 *       ...
 *     ],
 *     "count": 2
 *   }
 */
router.get('/conversations', (req, res) => {
  const db = req.app.locals.db;
  const { channel, limit = 100 } = req.query;

  let sql = 'SELECT id, channel_id, role, content, token_count, created_at FROM claude_conversations WHERE 1=1';
  const params = [];

  if (channel) {
    sql += ' AND channel_id = ?';
    params.push(channel);
  }

  sql += ' ORDER BY created_at DESC';

  const queryLimit = Math.min(parseInt(limit) || 100, 500);
  sql += ' LIMIT ?';
  params.push(queryLimit);

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('[claude.js] GET /conversations error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }

    // Reverse to get chronological order
    const messages = rows.reverse();

    return res.json({
      messages,
      count: messages.length
    });
  });
});

module.exports = router;
