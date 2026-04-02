/**
 * Darkhan — Unified Claude Session (v3)
 *
 * One Claude SDK session per user, two interfaces (terminal + chat).
 *
 * KEY DESIGN DECISIONS (2026-04-01):
 *   1. SDK v2's session.stream() is PER-TURN — yields events for one send(), then completes.
 *      The session stays alive for subsequent send() → stream() cycles.
 *   2. No heavy preamble. System prompt gives Claude identity + vault path.
 *      Claude reads files when it needs them, not upfront.
 *   3. Both chat and terminal get ALL stream events. The CALLER decides visibility:
 *      - Terminal subscriber renders to xterm (always)
 *      - Auto-responder posts to channel (for chat-sourced messages)
 *   4. Session persistence: session IDs saved to disk, resumed after server restart.
 */

const {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} = require('@anthropic-ai/claude-agent-sdk');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class UnifiedClaudeSession {
  constructor({ db, io, config, activityLog }) {
    this.db = db;
    this.io = io;
    this.config = config;
    this.activityLog = activityLog;
    this.sessions = new Map(); // userId -> entry
    this._creatingSession = new Map(); // userId -> Promise (mutex)

    const HOME = process.env.HOME || '';
    const vaultPath = config.vault?.path?.replace(/^~/, HOME);
    this.vaultPath = vaultPath || path.join(HOME, 'Documents', 'Feedback Loop');

    // Session persistence
    this._sessionFile = path.join(HOME, '.claude', 'darkhan-unified-sessions.json');
    this._storedSessions = this._loadStoredSessions();
  }

  // --- Session Lifecycle ---

  async getOrCreateSession(userId) {
    // 1. Return existing in-memory session
    let entry = this.sessions.get(userId);
    if (entry && entry.session) return entry;

    // Mutex: prevent double-spawn
    if (this._creatingSession.has(userId)) {
      await this._creatingSession.get(userId);
      entry = this.sessions.get(userId);
      if (entry && entry.session) return entry;
    }

    // 2. Try resume from stored session (survives server restart)
    const stored = this._storedSessions[userId];
    const MAX_AGE = 8 * 3600000;
    if (stored?.sessionId && (Date.now() - (stored.lastMessageAt || 0)) < MAX_AGE) {
      const promise = this._resumeSession(userId, stored.sessionId, stored.messageCount || 0);
      this._creatingSession.set(userId, promise);
      try {
        entry = await promise;
        if (entry) return entry;
      } catch (e) {
        console.log(`[UnifiedClaude] Resume failed: ${e.message}`);
      } finally {
        this._creatingSession.delete(userId);
      }
    }

    // 3. Create fresh
    const promise = this._createSession(userId);
    this._creatingSession.set(userId, promise);
    try {
      return await promise;
    } finally {
      this._creatingSession.delete(userId);
    }
  }

  async _resumeSession(userId, sessionId, messageCount = 0) {
    console.log(`[UnifiedClaude] Resuming session ${sessionId.substring(0, 8)}... for ${userId}`);
    const session = unstable_v2_resumeSession(sessionId, {
      model: 'opus',
      allowedTools: this._getAllowedTools(),
      cwd: this.vaultPath,
      permissionMode: 'bypassPermissions',
      includePartialMessages: true,
    });

    const entry = this._buildEntry(session, userId, sessionId, messageCount);
    this.sessions.set(userId, entry);
    console.log(`[UnifiedClaude] Resumed for ${userId} (${messageCount} prior msgs)`);
    return entry;
  }

  async _createSession(userId) {
    let channelContext = '';
    try { channelContext = await this._getRecentMessages('chan_command', 15); } catch {}

    const permMode = this.config.terminal?.permissionMode || 'bypassPermissions';
    const self = this;

    const sessionOpts = {
      model: 'opus',
      allowedTools: this._getAllowedTools(),
      cwd: this.vaultPath,
      permissionMode: permMode,
      systemPrompt: { type: 'preset', append: this._buildSystemPrompt(channelContext) },
      includePartialMessages: true,
    };

    // If not bypassing permissions, add the approval callback
    if (permMode !== 'bypassPermissions') {
      sessionOpts.canUseTool = async (toolName, input, options) => {
        return await self._handlePermissionRequest(userId, toolName, input, options);
      };
    }

    const session = unstable_v2_createSession(sessionOpts);

    const entry = this._buildEntry(session, userId, null, 0);
    this.sessions.set(userId, entry);

    this._postToChannel('chan_claude', `[Unified Session] Session created for ${userId} (permissions: ${permMode})`);
    console.log(`[UnifiedClaude] Created for ${userId} (cwd: ${this.vaultPath}, permissions: ${permMode})`);
    return entry;
  }

  _buildEntry(session, userId, sessionId, messageCount) {
    return {
      session,
      sessionId,
      subscribers: new Map(),
      userId,
      createdAt: Date.now(),
      messageCount: messageCount || 0,
      busy: false, // prevents concurrent send/stream
    };
  }

  _getAllowedTools() {
    return this.config.terminal?.allowedTools
      ? this.config.terminal.allowedTools.split(',').map(t => t.trim())
      : ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Agent'];
  }

  // --- Send Messages ---

  /**
   * Send from chat. Returns the response text (auto-responder posts to channel).
   * Terminal subscriber will also see it — that's fine, shared brain.
   */
  async sendFromChat(userId, message, channelId) {
    const entry = await this.getOrCreateSession(userId);

    // Wait if session is busy (previous turn still streaming)
    if (entry.busy) {
      console.log(`[UnifiedClaude] Session busy, waiting for previous turn...`);
      await this._waitForIdle(entry, 120000);
    }

    try {
      entry.busy = true;
      this._logActivity(userId, 'unified_user_message', {
        source: 'chat', channelId, message: message.substring(0, 500),
      });
      await entry.session.send(message);
      const response = await this._processStream(userId, entry);
      return response || '[No response]';
    } catch (err) {
      console.error(`[UnifiedClaude] Chat send failed:`, err.message);
      if (this._isSessionDead(err)) {
        return await this._retryMessage(userId, message, 'chat');
      }
      return `[Error: ${err.message}]`;
    } finally {
      entry.busy = false;
    }
  }

  /**
   * Send from terminal. Response streams to terminal subscriber in real-time.
   */
  async sendFromTerminal(userId, message) {
    const entry = await this.getOrCreateSession(userId);

    if (entry.busy) {
      this._notifySubscribers(entry, 'all', {
        type: 'info',
        text: '[Session is processing another request — waiting...]',
      });
      try {
        await this._waitForIdle(entry, 300000); // 5 min timeout
      } catch (e) {
        this._notifySubscribers(entry, 'all', {
          type: 'error',
          text: '[Timed out waiting for session — try again]',
        });
        return;
      }
    }

    try {
      entry.busy = true;
      this._logActivity(userId, 'unified_user_message', {
        source: 'terminal', message: message.substring(0, 500),
      });
      await entry.session.send(message);
      await this._processStream(userId, entry);
    } catch (err) {
      console.error(`[UnifiedClaude] Terminal send failed:`, err.message);
      if (this._isSessionDead(err)) {
        await this._retryMessage(userId, message, 'terminal', entry);
        return;
      }
      this._notifySubscribers(entry, 'all', {
        type: 'error',
        text: `[Error: ${err.message}]`,
      });
    } finally {
      entry.busy = false;
    }
  }

  /**
   * Retry a failed message by recreating the session.
   */
  async _retryMessage(userId, message, source, oldEntry) {
    console.log(`[UnifiedClaude] Session dead — recreating for ${userId}`);
    this.sessions.delete(userId);

    // Try resume first, then fresh
    let entry;
    const stored = this._storedSessions[userId];
    if (stored?.sessionId) {
      try { entry = await this._resumeSession(userId, stored.sessionId, stored.messageCount || 0); }
      catch (e) { /* fall through */ }
    }
    if (!entry) {
      entry = await this._createSession(userId);
    }

    try {
      entry.busy = true;
      await entry.session.send(message);
      const response = await this._processStream(userId, entry);
      entry.busy = false;

      if (source === 'chat') return response || '[No response]';
    } catch (retryErr) {
      entry.busy = false;
      const errText = `[Error after retry: ${retryErr.message}]`;
      if (source === 'terminal') {
        this._notifySubscribers(entry, 'all', { type: 'error', text: errText });
      }
      return errText;
    }
  }

  // --- Stream Processing ---

  /**
   * Process one turn's stream. Called after session.send().
   *
   * SDK v2 events: system, assistant, user, result, rate_limit_event
   * No streaming deltas — each assistant event has the complete message.
   *
   * ALL events go to ALL subscribers. Callers decide visibility.
   */
  async _processStream(userId, entry) {
    let fullText = '';
    let toolsUsed = [];
    const turnStart = Date.now();
    const TIMEOUT_MS = 300000; // 5 min max per turn

    try {
      const streamPromise = (async () => {
        for await (const event of entry.session.stream()) {
          switch (event.type) {
            case 'system': {
              if (event.session_id) {
                entry.sessionId = event.session_id;
                this._persistSession(userId, entry);
              }
              break;
            }

            case 'assistant': {
              const content = event.message?.content || [];
              const textBlocks = content.filter(b => b.type === 'text');
              const toolBlocks = content.filter(b => b.type === 'tool_use');
              const msgText = textBlocks.map(b => b.text).join('\n');

              if (msgText.length > 0) {
                fullText = msgText;
                this._notifySubscribers(entry, 'all', {
                  type: 'assistant_message',
                  text: msgText,
                });
                this._logActivity(userId, 'unified_assistant_message', {
                  length: msgText.length,
                  preview: msgText.substring(0, 300),
                });
              }

              for (const tool of toolBlocks) {
                const toolInput = this._summarizeToolInput(tool);
                toolsUsed.push(tool.name);
                this._notifySubscribers(entry, 'all', {
                  type: 'tool_summary',
                  text: `${tool.name}`,
                });
                this._logActivity(userId, 'unified_tool_call', {
                  tool: tool.name,
                  input: toolInput,
                });
              }
              break;
            }

            case 'result': {
              const isError = event.subtype === 'error';
              this._notifySubscribers(entry, 'all', {
                type: 'result',
                text: isError ? `[Error: ${event.error}]` : '',
                isError,
              });
              if (isError) {
                this._logActivity(userId, 'unified_turn_error', {
                  error: (event.error || '').substring(0, 300),
                });
              }
              break;
            }

            // Ignore: user, rate_limit_event
          }
        }
      })();

      // Race against timeout
      await Promise.race([
        streamPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Stream timeout (5 min)')), TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      console.error(`[UnifiedClaude] Stream error for ${userId}:`, err.message);
      this._notifySubscribers(entry, 'all', {
        type: 'error',
        text: `[Stream error: ${err.message}]`,
      });
    }

    entry.messageCount = (entry.messageCount || 0) + 1;
    this._persistSession(userId, entry);

    this._logActivity(userId, 'unified_turn_complete', {
      messageNumber: entry.messageCount,
      responseLength: fullText.length,
      toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      toolCount: toolsUsed.length,
      durationMs: Date.now() - turnStart,
    });

    console.log(`[UnifiedClaude] Turn complete for ${userId} (${fullText.length} chars, ${toolsUsed.length} tools, msg #${entry.messageCount})`);
    return fullText;
  }

  // --- Subscriber Management ---

  subscribe(userId, subscriberId, type, callback) {
    const entry = this.sessions.get(userId);
    if (entry) entry.subscribers.set(subscriberId, { type, callback });
  }

  unsubscribe(userId, subscriberId) {
    const entry = this.sessions.get(userId);
    if (entry) entry.subscribers.delete(subscriberId);
  }

  _notifySubscribers(entry, targetType, event) {
    for (const [id, sub] of entry.subscribers) {
      if (targetType === 'all' || sub.type === targetType) {
        try { sub.callback(event); }
        catch (err) { console.error(`[UnifiedClaude] Subscriber ${id} error:`, err.message); }
      }
    }
  }

  // --- Session Persistence ---

  _persistSession(userId, entry) {
    if (!entry.sessionId) return;
    this._storedSessions[userId] = {
      sessionId: entry.sessionId,
      createdAt: this._storedSessions[userId]?.createdAt || Date.now(),
      messageCount: entry.messageCount || 0,
      lastMessageAt: Date.now(),
    };
    this._saveStoredSessions();
  }

  _loadStoredSessions() {
    try {
      if (fs.existsSync(this._sessionFile)) {
        const data = JSON.parse(fs.readFileSync(this._sessionFile, 'utf8'));
        console.log(`[UnifiedClaude] Loaded ${Object.keys(data).length} stored session(s)`);
        return data;
      }
    } catch (e) { console.warn(`[UnifiedClaude] Load failed: ${e.message}`); }
    return {};
  }

  _saveStoredSessions() {
    try {
      const dir = path.dirname(this._sessionFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this._sessionFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._storedSessions, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this._sessionFile);
    } catch (e) { console.warn(`[UnifiedClaude] Save failed: ${e.message}`); }
  }

  // --- Helpers ---

  /**
   * Log an event to the immutable activity hash chain.
   */
  _logActivity(userId, action, details) {
    if (!this.activityLog) return;
    try {
      this.activityLog.append({
        actor: userId,
        action,
        target: 'unified_session',
        details: JSON.stringify(details),
      });
    } catch (err) {
      console.error(`[UnifiedClaude] Activity log error:`, err.message);
    }
  }

  /**
   * Summarize tool input for logging (keep concise, no secrets).
   */
  _summarizeToolInput(tool) {
    const input = tool.input || {};
    if (input.file_path) return input.file_path;
    if (input.command) return input.command.substring(0, 200);
    if (input.pattern) return `pattern: ${input.pattern}`;
    if (input.query) return input.query.substring(0, 200);
    if (input.content) return `[${input.content.length} chars]`;
    if (input.old_string) return `edit: ${(input.file_path || 'file')}`;
    const json = JSON.stringify(input);
    return json.length > 200 ? json.substring(0, 200) + '...' : json;
  }

  _isSessionDead(err) {
    const msg = err.message || '';
    return msg.includes('closed') || msg.includes('ended') || msg.includes('EPIPE') || msg.includes('killed');
  }

  async _waitForIdle(entry, timeoutMs) {
    const start = Date.now();
    while (entry.busy && (Date.now() - start) < timeoutMs) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (entry.busy) {
      throw new Error('Timed out waiting for session to become idle');
    }
  }

  _buildSystemPrompt(channelContext) {
    const today = new Date().toISOString().substring(0, 10);
    return [
      `DARKHAN UNIFIED SESSION — Date: ${today}`,
      `You are Claude, Chief of Staff for 5R Industries / Outlaw Motor Company.`,
      `Running inside the Darkhan web UI on Node 2.`,
      ``,
      `Your vault is at: ${this.vaultPath}`,
      `CLAUDE.md: ${this.vaultPath}/CLAUDE.md`,
      `State.md: ${this.vaultPath}/OMC-OS/State.md`,
      `USE ABSOLUTE PATHS for all file operations.`,
      ``,
      `Messages come from terminal (private) or chat channels (public).`,
      `Respond directly to the user. Read files only when you need specific info.`,
      channelContext ? `\nRecent #command messages:\n${channelContext}` : '',
    ].filter(Boolean).join('\n');
  }

  // --- Permission Routing ---

  /**
   * Check if any terminal subscriber is active for a user.
   */
  _hasTerminalSubscriber(userId) {
    const entry = this.sessions.get(userId);
    if (!entry) return false;
    for (const [id, sub] of entry.subscribers) {
      if (sub.type === 'terminal') return true;
    }
    return false;
  }

  /**
   * Handle a permission request from the SDK.
   * Routes to terminal (if open) or chat (if not), waits for user decision.
   */
  async _handlePermissionRequest(userId, toolName, input, options) {
    const entry = this.sessions.get(userId);
    const displayName = options.displayName || toolName;
    const description = options.description || '';
    const title = options.title || `Claude wants to use: ${toolName}`;
    const toolUseID = options.toolUseID;

    const hasTerminal = this._hasTerminalSubscriber(userId);

    // Build a formatted summary of what the tool wants to do
    const inputSummary = this._formatToolInput(toolName, input);

    if (hasTerminal) {
      // Terminal is open — show the prompt there and wait for input
      return await this._requestTerminalApproval(userId, entry, {
        toolName, displayName, title, description, inputSummary, toolUseID, options,
      });
    } else {
      // No terminal — post to chat and wait for response
      return await this._requestChatApproval(userId, entry, {
        toolName, displayName, title, description, inputSummary, toolUseID, options,
      });
    }
  }

  /**
   * Format tool input for display (keep it concise).
   */
  _formatToolInput(toolName, input) {
    if (!input) return '';
    if (input.file_path) return input.file_path;
    if (input.command) return input.command.substring(0, 120);
    if (input.pattern) return `pattern: ${input.pattern}`;
    if (input.query) return input.query.substring(0, 120);
    if (input.url) return input.url;
    const json = JSON.stringify(input);
    return json.length > 120 ? json.substring(0, 120) + '...' : json;
  }

  /**
   * Show permission prompt in terminal, wait for y/n input.
   */
  _requestTerminalApproval(userId, entry, req) {
    return new Promise((resolve) => {
      // Render the prompt to all terminal subscribers
      const prompt = [
        `\r\n\x1b[1;33m┌─ Permission Request ─────────────────────\x1b[0m`,
        `\x1b[33m│\x1b[0m ${req.title}`,
        req.inputSummary ? `\x1b[33m│\x1b[0m ${req.inputSummary}` : null,
        req.description ? `\x1b[33m│\x1b[90m ${req.description}\x1b[0m` : null,
        `\x1b[33m│\x1b[0m`,
        `\x1b[33m│\x1b[0m  \x1b[32m[y]\x1b[0m Allow   \x1b[31m[n]\x1b[0m Deny   \x1b[36m[a]\x1b[0m Always allow`,
        `\x1b[1;33m└──────────────────────────────────────────\x1b[0m`,
        `\x1b[33m? \x1b[0m`,
      ].filter(Boolean).join('\r\n');

      this._notifySubscribers(entry, 'terminal', {
        type: 'permission_prompt',
        text: prompt,
      });

      // Store pending permission — terminal-relay will intercept next input
      entry.pendingPermission = {
        resolve: (decision) => {
          entry.pendingPermission = null;
          resolve(decision);
        },
        toolName: req.toolName,
        toolUseID: req.toolUseID,
        options: req.options,
      };
    });
  }

  /**
   * Post permission prompt to chat, wait for approval message.
   */
  _requestChatApproval(userId, entry, req) {
    return new Promise((resolve) => {
      const body = [
        `**Permission Request**`,
        `Claude wants to: **${req.displayName || req.toolName}**`,
        req.inputSummary ? `\`${req.inputSummary}\`` : '',
        req.description || '',
        ``,
        `Reply \`approve\` or \`deny\``,
      ].filter(Boolean).join('\n');

      this._postToChannel('chan_command', body);

      // Store pending permission — auto-responder will check for approval messages
      entry.pendingPermission = {
        resolve: (decision) => {
          entry.pendingPermission = null;
          resolve(decision);
        },
        toolName: req.toolName,
        toolUseID: req.toolUseID,
        options: req.options,
      };
    });
  }

  /**
   * Resolve a pending permission with allow/deny.
   * Called by terminal-relay (terminal input) or auto-responder (chat message).
   */
  resolvePermission(userId, decision) {
    const entry = this.sessions.get(userId);
    if (!entry || !entry.pendingPermission) return false;

    const pending = entry.pendingPermission;
    const toolUseID = pending.toolUseID;

    if (decision === 'allow') {
      this._logActivity(userId, 'unified_permission_granted', {
        tool: pending.toolName, decision: 'allow',
      });
      pending.resolve({
        behavior: 'allow',
        updatedInput: undefined,
        toolUseID,
      });
      return true;
    } else if (decision === 'always') {
      this._logActivity(userId, 'unified_permission_granted', {
        tool: pending.toolName, decision: 'always_allow',
      });
      pending.resolve({
        behavior: 'allow',
        updatedInput: undefined,
        updatedPermissions: pending.options.suggestions || [],
        toolUseID,
        decisionClassification: 'user_permanent',
      });
      return true;
    } else {
      this._logActivity(userId, 'unified_permission_denied', {
        tool: pending.toolName, decision: 'deny',
      });
      pending.resolve({
        behavior: 'deny',
        message: 'User denied permission',
        interrupt: false,
        toolUseID,
      });
      return true;
    }
  }

  /**
   * Check if there's a pending permission for a user.
   */
  hasPendingPermission(userId) {
    const entry = this.sessions.get(userId);
    return !!(entry && entry.pendingPermission);
  }

  async closeSession(userId, { clearStored = false } = {}) {
    const entry = this.sessions.get(userId);
    if (!entry) return;
    try { entry.session.close(); } catch {}
    this.sessions.delete(userId);
    if (clearStored) {
      delete this._storedSessions[userId];
      this._saveStoredSessions();
    }
    console.log(`[UnifiedClaude] Closed for ${userId}`);
  }

  _postToChannel(channelId, body) {
    if (!this.db) return;
    const id = crypto.randomUUID();
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

  getStatus() {
    const active = [];
    for (const [userId, entry] of this.sessions) {
      active.push({
        userId, sessionId: entry.sessionId,
        subscriberCount: entry.subscribers.size,
        messageCount: entry.messageCount || 0,
        busy: entry.busy || false,
      });
    }
    return { activeSessions: active.length, sessions: active, storedSessions: Object.keys(this._storedSessions).length };
  }

  async shutdown() {
    for (const [userId] of this.sessions) await this.closeSession(userId);
  }
}

module.exports = { UnifiedClaudeSession };
