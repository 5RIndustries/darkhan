/**
 * Darkhan — Unified Claude Session
 *
 * THE KEYSTONE: One Claude SDK session per user, two interfaces (terminal + chat).
 *
 * Architecture:
 *   Chat (@claude in channels)  ──┐
 *                                  ├──> SDKSession (single process) ──> Stream events
 *   Terminal (xterm.js in UI)   ──┘         │
 *                                           ├──> Terminal: renders as ANSI text
 *                                           └──> Chat: posts as channel messages
 *
 * The SDK's `unstable_v2_createSession` spawns a persistent Claude process.
 * `session.send()` feeds messages from either interface.
 * `session.stream()` yields structured events routed to both.
 */

const {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} = require('@anthropic-ai/claude-agent-sdk');
const { v4: uuidv4 } = require('uuid');

class UnifiedClaudeSession {
  constructor({ db, io, config, activityLog }) {
    this.db = db;
    this.io = io;
    this.config = config;
    this.activityLog = activityLog;
    this.sessions = new Map(); // userId -> { session, streaming, subscribers, sessionId }
  }

  /**
   * Get or create a persistent Claude session for a user.
   */
  async getOrCreateSession(userId) {
    let entry = this.sessions.get(userId);
    if (entry && entry.session) {
      return entry;
    }

    const allowedTools = this.config.terminal?.allowedTools
      ? this.config.terminal.allowedTools.split(',').map(t => t.trim())
      : ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Agent'];

    // Build channel context for Claude
    let channelContext = '';
    try {
      channelContext = await this._getRecentMessages('chan_command', 15);
    } catch {}

    const systemPromptAppend =
      `DARKHAN UNIFIED SESSION: You are running inside the Darkhan web UI. ` +
      `Messages may come from the terminal view (interactive) or the chat view (@claude). ` +
      `Other agents communicate via Darkhan channels. ` +
      (channelContext ? `Recent #command messages:\n${channelContext}\n\n` : '') +
      `Respond naturally to whatever input you receive. Your full tool set is available.`;

    const session = unstable_v2_createSession({
      model: 'opus',
      allowedTools,
      cwd: process.env.HOME,
      permissionMode: 'bypassPermissions',
      systemPrompt: { type: 'preset', append: systemPromptAppend },
      includePartialMessages: true,
    });

    entry = {
      session,
      sessionId: null, // populated after first message
      subscribers: new Map(), // subscriberId -> { type: 'terminal'|'chat', callback }
      streaming: false,
      messageQueue: [],
      userId,
    };

    this.sessions.set(userId, entry);

    // Start the stream reader loop
    this._startStreamReader(userId, entry);

    if (this.activityLog) {
      try {
        this.activityLog.append({
          actor: userId,
          action: 'unified_claude_session_created',
          details: JSON.stringify({ model: 'opus' }),
        });
      } catch {}
    }

    this._postToChannel('chan_claude', `[Unified Session] Claude session created for ${userId}`);
    console.log(`[UnifiedClaude] Session created for ${userId}`);

    return entry;
  }

  /**
   * Send a message from the chat interface.
   * Returns the assistant's response text for posting to the channel.
   */
  async sendFromChat(userId, message, channelId) {
    const entry = await this.getOrCreateSession(userId);
    const responsePromise = this._createResponsePromise(entry, 'chat');

    try {
      await entry.session.send(message);
    } catch (err) {
      console.error(`[UnifiedClaude] Send failed for ${userId}:`, err.message);
      return `[Error: ${err.message}]`;
    }

    // Wait for the response to complete
    const response = await responsePromise;
    return response;
  }

  /**
   * Send a message from the terminal interface.
   * Output is streamed to the terminal subscriber in real-time.
   */
  async sendFromTerminal(userId, message) {
    const entry = await this.getOrCreateSession(userId);

    try {
      await entry.session.send(message);
    } catch (err) {
      console.error(`[UnifiedClaude] Terminal send failed for ${userId}:`, err.message);
      this._notifySubscribers(entry, 'terminal', {
        type: 'error',
        text: `[Error: ${err.message}]`,
      });
    }
  }

  /**
   * Subscribe to session events (terminal or chat).
   */
  subscribe(userId, subscriberId, type, callback) {
    const entry = this.sessions.get(userId);
    if (!entry) return;
    entry.subscribers.set(subscriberId, { type, callback });
  }

  /**
   * Unsubscribe from session events.
   */
  unsubscribe(userId, subscriberId) {
    const entry = this.sessions.get(userId);
    if (!entry) return;
    entry.subscribers.delete(subscriberId);
  }

  /**
   * Close a user's session.
   */
  async closeSession(userId) {
    const entry = this.sessions.get(userId);
    if (!entry) return;

    try {
      entry.session.close();
    } catch {}

    this.sessions.delete(userId);
    this._postToChannel('chan_claude', `[Unified Session] Claude session ended for ${userId}`);
    console.log(`[UnifiedClaude] Session closed for ${userId}`);
  }

  /**
   * The core stream reader — processes SDK events and routes them to subscribers.
   */
  async _startStreamReader(userId, entry) {
    try {
      for await (const event of entry.session.stream()) {
        // Capture session ID from first event
        if (!entry.sessionId && event.session_id) {
          entry.sessionId = event.session_id;
        }

        switch (event.type) {
          case 'stream_event': {
            // Partial assistant message — streaming text delta
            const delta = event.event;
            if (delta.type === 'content_block_delta' && delta.delta?.type === 'text_delta') {
              this._notifySubscribers(entry, 'all', {
                type: 'text_delta',
                text: delta.delta.text,
              });
            }
            break;
          }

          case 'assistant': {
            // Complete assistant message
            const content = event.message?.content || [];
            const textBlocks = content.filter(b => b.type === 'text');
            const fullText = textBlocks.map(b => b.text).join('\n');

            this._notifySubscribers(entry, 'all', {
              type: 'assistant_message',
              text: fullText,
              messageId: event.uuid,
            });

            // Bridge: post completed responses to channel
            if (fullText.length > 0 && fullText.length < 4000) {
              this._postToChannel('chan_claude',
                `**Claude:** ${fullText.substring(0, 2000)}${fullText.length > 2000 ? '...' : ''}`);
            }
            break;
          }

          case 'tool_use_summary': {
            this._notifySubscribers(entry, 'all', {
              type: 'tool_summary',
              text: event.summary,
            });
            break;
          }

          case 'system': {
            this._notifySubscribers(entry, 'all', {
              type: 'system',
              text: event.message || '[system event]',
            });
            break;
          }

          case 'result': {
            const isError = event.type === 'result' && event.subtype === 'error';
            this._notifySubscribers(entry, 'all', {
              type: 'result',
              text: isError ? `[Error: ${event.error}]` : '[Session turn complete]',
              isError,
            });
            break;
          }

          default:
            // Log but don't crash on unknown event types
            break;
        }
      }
    } catch (err) {
      console.error(`[UnifiedClaude] Stream error for ${userId}:`, err.message);
      this._notifySubscribers(entry, 'all', {
        type: 'error',
        text: `[Stream error: ${err.message}]`,
      });
    }

    // Stream ended — clean up
    this.sessions.delete(userId);
    console.log(`[UnifiedClaude] Stream ended for ${userId}`);
  }

  /**
   * Notify subscribers of a specific type (or 'all').
   */
  _notifySubscribers(entry, targetType, event) {
    for (const [id, sub] of entry.subscribers) {
      if (targetType === 'all' || sub.type === targetType) {
        try {
          sub.callback(event);
        } catch (err) {
          console.error(`[UnifiedClaude] Subscriber ${id} error:`, err.message);
        }
      }
    }
  }

  /**
   * Create a promise that resolves when the assistant finishes a response.
   */
  _createResponsePromise(entry, type) {
    return new Promise((resolve) => {
      const tempId = `_response_${Date.now()}`;
      let fullText = '';

      entry.subscribers.set(tempId, {
        type,
        callback: (event) => {
          if (event.type === 'text_delta') {
            fullText += event.text;
          } else if (event.type === 'assistant_message') {
            fullText = event.text;
          } else if (event.type === 'result' || event.type === 'error') {
            entry.subscribers.delete(tempId);
            resolve(fullText || event.text || '[No response]');
          }
        },
      });
    });
  }

  /**
   * Post a message to a Darkhan channel (bridge).
   */
  _postToChannel(channelId, body) {
    if (!this.db) return;
    const id = uuidv4();
    this.db.run(
      `INSERT INTO messages (id, channel_id, from_user, body, priority, type) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, channelId, 'agent_claude', body, 'low', 'message'],
      (err) => {
        if (err) return;
        if (this.io) {
          this.io.to(channelId).emit('new_message', {
            id, channel_id: channelId, from_user: 'agent_claude',
            body, priority: 'low', type: 'message',
            created_at: new Date().toISOString(),
          });
        }
      }
    );
  }

  /**
   * Get recent messages from a channel.
   */
  _getRecentMessages(channelId, limit = 10) {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve('');
      this.db.all(
        `SELECT from_user, body, created_at FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`,
        [channelId, limit],
        (err, rows) => {
          if (err) return reject(err);
          if (!rows || rows.length === 0) return resolve('');
          resolve(rows.reverse().map(r =>
            `[${r.created_at}] ${r.from_user}: ${r.body.substring(0, 300)}`
          ).join('\n'));
        }
      );
    });
  }

  /**
   * Get status of all active sessions.
   */
  getStatus() {
    const active = [];
    for (const [userId, entry] of this.sessions) {
      active.push({
        userId,
        sessionId: entry.sessionId,
        subscriberCount: entry.subscribers.size,
      });
    }
    return { activeSessions: active.length, sessions: active };
  }

  /**
   * Shutdown all sessions.
   */
  async shutdown() {
    for (const [userId] of this.sessions) {
      await this.closeSession(userId);
    }
  }
}

module.exports = { UnifiedClaudeSession };
