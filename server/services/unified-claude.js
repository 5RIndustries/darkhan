/**
 * Darkhan — Unified Claude Session (v3)
 *
 * One Claude SDK session per user, two interfaces (terminal + chat).
 *
 * KEY DESIGN DECISIONS (2026-04-01):
 *   1. SDK v2's session.stream() is PER-TURN — yields events for one send(), then completes.
 *      The session stays alive for subsequent send() → stream() cycles.
 *   2. No heavy preamble. System prompt gives Claude identity + folio path.
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

// --- Execution Tier: Tool Classification ---
// Tools are grouped by risk level. The user's execution tier determines
// which groups are pre-approved vs require interactive approval.
//
// HARD SECURITY BOUNDARY: These tools ALWAYS require approval regardless of tier.
// This is architectural, not policy — even 'autonomous' tier cannot bypass this.
const SECURITY_BOUNDARY_PATTERNS = [
  // No tool patterns here — security is enforced by input inspection, not tool name.
  // The boundary is about WHAT you do, not WHICH tool you use.
];

// Tool risk classification:
//   read    — passive observation, no side effects
//   write   — modifies files, runs commands, makes changes
//   security — touches credentials, auth, admin operations
const TOOL_CLASSIFICATION = {
  // Read-only tools
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  WebSearch: 'read',
  WebFetch: 'read',

  // Write tools — modifiable side effects
  Write: 'write',
  Edit: 'write',
  Bash: 'write',   // Classified as write; security-sensitive commands caught by input inspection
  Agent: 'write',
  NotebookEdit: 'write',
};

// Input patterns that escalate ANY tool to 'security' classification.
// These catch dangerous operations regardless of which tool is used.
const SECURITY_INPUT_PATTERNS = [
  // Credential/auth keywords in bash commands
  /\b(password|passwd|secret|credential|api.key|token|pin)\b/i,
  // Admin operations
  /\b(lockdown|break.glass|unlock|set.pin)\b/i,
  // Destructive git operations
  /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-f)/i,
  // Direct database access
  /\b(sqlite3|\.db\b|secrets\.db)/i,
  // Env/credential files
  /\.(env|pem|key|cert)\b/,
  // Service user / sudo operations
  /\b(sudo|su\s|_darkhan)\b/i,
  // Integrity baseline — agents must not delete or modify the baseline file
  /integrity-baseline/,
];

/**
 * Classify a tool call by risk level, considering both tool name and input.
 * Returns: 'read', 'write', or 'security'
 */
function classifyToolCall(toolName, input) {
  let level = TOOL_CLASSIFICATION[toolName] || 'write'; // Unknown tools default to write

  // Escalate to security if input matches sensitive patterns
  if (level !== 'security' && input) {
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
    for (const pattern of SECURITY_INPUT_PATTERNS) {
      if (pattern.test(inputStr)) {
        return 'security';
      }
    }
  }

  return level;
}

/**
 * Check if a tool call is pre-approved under the given execution tier.
 *
 * Tiers:
 *   supervised  — only 'read' tools are pre-approved
 *   operational — 'read' and 'write' tools are pre-approved
 *   autonomous  — everything EXCEPT 'security' is pre-approved
 *
 * 'security' classification ALWAYS requires approval. This is the hard boundary.
 */
function isTierApproved(tier, classification) {
  switch (tier) {
    case 'autonomous':
      return classification !== 'security';
    case 'operational':
      return classification === 'read' || classification === 'write';
    case 'supervised':
    default:
      return classification === 'read';
  }
}

// Session cycling threshold — read from config.leadAgent.sessionCycleMessages.
// Defaults to 50 if not configured. The hash-chain activity log preserves
// full history, so sessions can be short without losing continuity.
const DEFAULT_SESSION_CYCLE = 50;

class UnifiedClaudeSession {
  constructor({ db, io, config, activityLog }) {
    this.db = db;
    this.io = io;
    this.config = config;
    this.activityLog = activityLog;
    this.sessions = new Map(); // userId -> entry
    this._creatingSession = new Map(); // userId -> Promise (mutex)

    const HOME = process.env.HOME || '';
    const folioPath = config.folio?.path?.replace(/^~/, HOME);
    this.folioPath = folioPath || path.join(HOME, 'darkhan-folio');

    // Lead agent config — platform-level settings for session management
    const lead = config.leadAgent || {};
    this.maxSessionMessages = lead.sessionCycleMessages || DEFAULT_SESSION_CYCLE;
    this.channelContextMessages = lead.channelContextMessages || 100;
    this.transcriptReadDays = lead.transcriptReadDays || 2;
    this.stateMaintenance = lead.stateMaintenance !== false;
    this.stateFile = lead.stateFile || null;
    this.startupProtocol = lead.startupProtocol !== false;
    this.transcriptDir = path.resolve(__dirname, '..', '..', 'docs', 'transcripts');

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
    // Always resume if we have a valid stored session — cycling happens after
    // turn completion, not preemptively. This preserves continuity across restarts.
    const stored = this._storedSessions[userId];
    const MAX_AGE = 8 * 3600000;
    if (stored?.sessionId && (Date.now() - (stored.lastMessageAt || 0)) < MAX_AGE) {
      const promise = this._resumeSession(userId, stored.sessionId, stored.messageCount || 0);
      this._creatingSession.set(userId, promise);
      try {
        // Timeout resume attempts — if the SDK session is dead, don't hang forever
        const RESUME_TIMEOUT = 15000;
        entry = await Promise.race([
          promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Resume timeout (15s)')), RESUME_TIMEOUT)),
        ]);
        if (entry) return entry;
      } catch (e) {
        console.log(`[UnifiedClaude] Resume failed: ${e.message} — creating fresh session`);
        // Clean up the dead stored session
        delete this._storedSessions[userId];
        this._saveStoredSessions();
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
      cwd: this.folioPath,
      permissionMode: 'bypassPermissions',
      includePartialMessages: true,
    });

    const entry = this._buildEntry(session, userId, sessionId, messageCount);
    this.sessions.set(userId, entry);
    console.log(`[UnifiedClaude] Resumed for ${userId} (${messageCount} prior msgs)`);
    return entry;
  }

  async _createSession(userId) {
    // Pull channel context: last 3 hours (up to 200 messages).
    // If nothing in the last 3 hours (overnight, long gap), fall back to last 100 messages.
    // Guarantees the agent always has meaningful context to start with.
    let channelContext = '';
    try {
      channelContext = await this._getTimedChannelContext(3, 200);
      if (!channelContext) {
        // No messages in last 3 hours — fall back to last 100 by count
        channelContext = await this._getRecentChannelContext(100);
        if (channelContext) {
          console.log(`[UnifiedClaude] No messages in last 3h — using last 100 messages as fallback`);
        }
      }
    } catch (e) {
      console.warn(`[UnifiedClaude] Channel context failed: ${e.message}`);
    }

    // Read State.md directly and inject it — don't rely on the agent to read it
    let stateContent = '';
    if (this.stateFile) {
      try {
        const statePath = path.join(this.folioPath, this.stateFile);
        stateContent = fs.readFileSync(statePath, 'utf8');
        // Trim to first 3000 chars (header + current sprint section) to keep prompt manageable
        if (stateContent.length > 3000) {
          stateContent = stateContent.substring(0, 3000) + '\n... [truncated — read full file for details]';
        }
      } catch (e) {
        stateContent = `(Could not read ${this.stateFile}: ${e.message})`;
      }
    }

    // Pull system-level events from the activity log (security, session cycles,
    // tier changes — things NOT captured in channel messages)
    let activityDigest = '';
    try { activityDigest = await this._getActivityDigest(6); } catch (e) {
      console.warn(`[UnifiedClaude] Activity digest failed: ${e.message}`);
    }

    const userTier = await this._getUserExecutionTier(userId);
    const self = this;

    const sessionOpts = {
      model: 'opus',
      allowedTools: this._getAllowedTools(),
      cwd: this.folioPath,
      permissionMode: 'bypassPermissions', // We handle permissions ourselves via canUseTool
      systemPrompt: { type: 'preset', append: this._buildSystemPrompt(channelContext, userTier, activityDigest, stateContent) },
      includePartialMessages: true,
    };

    // Execution tier callback — classifies each tool call and decides approval
    // 'supervised' users get prompted for writes; 'operational' for security only; etc.
    // Even in 'autonomous' mode, security-classified operations require approval.
    if (userTier !== 'autonomous') {
      sessionOpts.canUseTool = async (toolName, input, options) => {
        const classification = classifyToolCall(toolName, input);
        if (isTierApproved(userTier, classification)) {
          // Pre-approved by tier — log and allow silently
          self._logActivity(userId, 'tier_auto_approved', {
            tool: toolName, tier: userTier, classification,
          });
          return { behavior: 'allow', updatedInput: undefined, toolUseID: options.toolUseID };
        }
        // Not pre-approved — prompt the user
        return await self._handlePermissionRequest(userId, toolName, input, options);
      };
    }
    // autonomous tier: canUseTool is still needed for security boundary
    if (userTier === 'autonomous') {
      sessionOpts.canUseTool = async (toolName, input, options) => {
        const classification = classifyToolCall(toolName, input);
        if (classification === 'security') {
          // Hard security boundary — always prompt even in autonomous mode
          self._logActivity(userId, 'security_boundary_prompt', {
            tool: toolName, tier: userTier, classification,
          });
          return await self._handlePermissionRequest(userId, toolName, input, options);
        }
        // Everything else is pre-approved
        return { behavior: 'allow', updatedInput: undefined, toolUseID: options.toolUseID };
      };
    }

    const session = unstable_v2_createSession(sessionOpts);

    const entry = this._buildEntry(session, userId, null, 0);
    entry.executionTier = userTier;
    this.sessions.set(userId, entry);

    this._postToChannel('chan_system', `[Unified Session] Session created for ${userId} (tier: ${userTier})`);
    console.log(`[UnifiedClaude] Created for ${userId} (cwd: ${this.folioPath}, tier: ${userTier})`);
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
      busySince: null, // timestamp when busy was set — used for stale detection
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
  async sendFromChat(userId, message, channelId, { onProgress } = {}) {
    const entry = await this.getOrCreateSession(userId);

    // Attach any pending terminal subscribers that were waiting for session creation.
    // This handles the case where the terminal connects before any chat message creates
    // the session — the subscriber callback was saved but couldn't attach to a non-existent session.
    this._attachPendingSubscribers(userId);

    // Wait if session is busy (previous turn still streaming)
    if (entry.busy) {
      console.log(`[UnifiedClaude] Session busy, waiting for previous turn...`);
      await this._waitForIdle(entry, 120000);
    }

    try {
      entry.busy = true;
      entry.busySince = Date.now();
      this._logActivity(userId, 'unified_user_message', {
        source: 'chat', channelId, message: message.substring(0, 500),
      });
      await entry.session.send(message);
      const response = await this._processStream(userId, entry, { onProgress });

      // Session cycling: start fresh after this.maxSessionMessages
      // The hash-chain log preserves history; new session gets recent channel context
      if (entry.messageCount >= this.maxSessionMessages) {
        this._cycleSession(userId, entry);
      }

      return response || '[No response]';
    } catch (err) {
      console.error(`[UnifiedClaude] Chat send failed:`, err.message);
      if (this._isSessionDead(err)) {
        return await this._retryMessage(userId, message, 'chat');
      }
      return `[Error: ${err.message}]`;
    } finally {
      entry.busy = false;
      entry.busySince = null;
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
      entry.busySince = Date.now();
      this._logActivity(userId, 'unified_user_message', {
        source: 'terminal', message: message.substring(0, 500),
      });
      await entry.session.send(message);
      await this._processStream(userId, entry);

      // Session cycling
      if (entry.messageCount >= this.maxSessionMessages) {
        this._cycleSession(userId, entry);
      }
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
      entry.busySince = null;
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
      entry.busySince = Date.now();
      await entry.session.send(message);
      const response = await this._processStream(userId, entry);
      entry.busy = false;
      entry.busySince = null;

      if (source === 'chat') return response || '[No response]';
    } catch (retryErr) {
      entry.busy = false;
      entry.busySince = null;
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
  async _processStream(userId, entry, { onProgress } = {}) {
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

                // Progress callback — lets the caller update UI (e.g., thinking indicator)
                if (onProgress) {
                  try {
                    onProgress({
                      toolName: tool.name,
                      toolCount: toolsUsed.length,
                      elapsed: Math.round((Date.now() - turnStart) / 1000),
                    });
                  } catch {}
                }
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

  /**
   * Register a subscriber that will be attached once a session exists.
   * Used by terminal-relay when it connects before any session is created.
   */
  registerPendingSubscriber(userId, subscriberId, type, callback) {
    if (!this._pendingSubscribers) this._pendingSubscribers = new Map();
    if (!this._pendingSubscribers.has(userId)) this._pendingSubscribers.set(userId, []);
    this._pendingSubscribers.get(userId).push({ subscriberId, type, callback });
  }

  /**
   * Attach any pending subscribers to the now-existing session.
   */
  _attachPendingSubscribers(userId) {
    if (!this._pendingSubscribers?.has(userId)) return;
    const entry = this.sessions.get(userId);
    if (!entry) return;

    const pending = this._pendingSubscribers.get(userId);
    for (const { subscriberId, type, callback } of pending) {
      if (!entry.subscribers.has(subscriberId)) {
        entry.subscribers.set(subscriberId, { type, callback });
        console.log(`[UnifiedClaude] Attached pending subscriber ${subscriberId} for ${userId}`);
      }
    }
    this._pendingSubscribers.delete(userId);
  }

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
    // Safety valve: if busy flag has been set for longer than the stream timeout (5 min)
    // plus a 30s grace period, it's stale — force-clear it
    const STALE_THRESHOLD_MS = 330000; // 5.5 min
    if (entry.busy && entry.busySince && (Date.now() - entry.busySince) > STALE_THRESHOLD_MS) {
      console.warn(`[UnifiedClaude] Stale busy flag detected (${Math.round((Date.now() - entry.busySince) / 1000)}s) — force-clearing`);
      entry.busy = false;
      entry.busySince = null;
      return;
    }

    const start = Date.now();
    while (entry.busy && (Date.now() - start) < timeoutMs) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (entry.busy) {
      console.warn(`[UnifiedClaude] Wait timeout (${timeoutMs}ms) — force-clearing busy flag`);
      entry.busy = false;
      entry.busySince = null;
    }
  }

  /**
   * Fetch the user's execution tier from the database.
   * Returns 'supervised' if not set or user not found.
   */
  /**
   * Build a condensed digest of the last N hours of activity log entries.
   * Focuses on meaningful actions (user messages, tool calls, session events,
   * security events) and skips noise (heartbeats, rate limit events).
   *
   * This gives a fresh session real continuity from the immutable hash chain —
   * not reconstructed summaries, but actual records of what happened.
   */
  _getActivityDigest(hours = 6) {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve('');

      const since = new Date(Date.now() - hours * 3600000).toISOString();

      // Query ONLY system-level events — conversation content is already in the
      // channel messages context. This covers security events, session lifecycle,
      // tier changes, and other infrastructure events not visible in chat.
      this.db.all(
        `SELECT actor, action, target, details, created_at FROM activity_log
         WHERE created_at > ?
           AND action IN (
             'session_cycled', 'execution_tier_changed',
             'lockdown_activated', 'lockdown_lifted', 'integrity_violation',
             'server_started', 'baseline_established',
             'login_failed', 'login_rate_limited',
             'recovery_token_generated', 'password_reset_via_token',
             'security_boundary_prompt', 'unified_permission_denied'
           )
           AND entry_type = 'event'
         ORDER BY created_at ASC
         LIMIT 50`,
        [since],
        (err, rows) => {
          if (err) return reject(err);
          if (!rows || rows.length === 0) return resolve('(No activity in the last 6 hours)');

          // Group into a readable digest
          const lines = [];
          let lastAction = '';

          for (const row of rows) {
            const time = row.created_at?.substring(11, 19) || '??:??:??';
            const actor = row.actor || 'unknown';
            const action = row.action || 'unknown';

            // Collapse consecutive identical actions (e.g., many tier_auto_approved)
            if (action === lastAction && action === 'tier_auto_approved') continue;
            lastAction = action;

            // Format based on action type
            let line;
            switch (action) {
              case 'unified_user_message': {
                const d = this._safeParseJSON(row.details);
                line = `[${time}] USER (${d.source || 'chat'}): ${d.message || '(no content)'}`;
                break;
              }
              case 'unified_assistant_message': {
                const d = this._safeParseJSON(row.details);
                line = `[${time}] CLAUDE: ${d.preview || `(${d.length} chars)`}`;
                break;
              }
              case 'unified_tool_call': {
                const d = this._safeParseJSON(row.details);
                line = `[${time}] TOOL: ${d.tool} — ${d.input || ''}`;
                break;
              }
              case 'unified_turn_complete': {
                const d = this._safeParseJSON(row.details);
                line = `[${time}] TURN #${d.messageNumber}: ${d.responseLength} chars, ${d.toolCount} tools, ${d.durationMs}ms`;
                break;
              }
              case 'session_cycled': {
                const d = this._safeParseJSON(row.details);
                line = `[${time}] SESSION CYCLED after ${d.messageCount} messages`;
                break;
              }
              case 'execution_tier_changed': {
                const d = this._safeParseJSON(row.details);
                line = `[${time}] TIER CHANGED to ${d.tier} by ${actor}`;
                break;
              }
              case 'lockdown_activated':
              case 'lockdown_lifted':
              case 'integrity_violation':
                line = `[${time}] SECURITY: ${action} — ${row.details || ''}`;
                break;
              default:
                // Include but keep concise
                line = `[${time}] ${actor}/${action}: ${(row.details || '').substring(0, 120)}`;
            }

            if (line) lines.push(line);
          }

          resolve(lines.join('\n'));
        }
      );
    });
  }

  _safeParseJSON(str) {
    try { return JSON.parse(str || '{}'); } catch { return {}; }
  }

  _getUserExecutionTier(userId) {
    return new Promise((resolve) => {
      if (!this.db) return resolve('supervised');
      this.db.get('SELECT execution_tier FROM users WHERE id = ?', [userId], (err, row) => {
        if (err || !row) return resolve('supervised');
        resolve(row.execution_tier || 'supervised');
      });
    });
  }

  _buildSystemPrompt(channelContext, executionTier, activityDigest, stateContent) {
    const today = new Date().toISOString().substring(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10);

    const lines = [
      `DARKHAN UNIFIED SESSION — Date: ${today}`,
      `Running inside the Darkhan web UI.`,
      ``,
      `Folio: ${this.folioPath}`,
      `USE ABSOLUTE PATHS for all file operations.`,
      ``,
      `EXECUTION TIER: ${executionTier || 'supervised'}`,
      executionTier === 'supervised' ? `Supervised mode. Read operations pre-approved. All writes require user approval.` : '',
      executionTier === 'operational' ? `Operational mode. Code edits, file writes, commands pre-approved. Security ops require approval.` : '',
      executionTier === 'autonomous' ? `Autonomous mode. Everything pre-approved EXCEPT security-sensitive actions (credentials, auth, admin, break-glass).` : '',
      ``,
    ];

    // Startup protocol — from platform config
    if (this.startupProtocol) {
      lines.push(
        `=== STARTUP PROTOCOL ===`,
        `Context has been pre-loaded into this prompt by the Darkhan platform:`,
        `- Last 3 hours of channel messages (below)`,
        `- Current state file summary (below)`,
        `- System events (below)`,
        ``,
        `On your FIRST turn, read your operating instructions: ${this.folioPath}/CLAUDE.md`,
        `(If no CLAUDE.md exists, check for agent instructions in the folio root.)`,
        ``,
        `For DEEPER context beyond what's in this prompt, read the full transcripts:`,
        `- Today: ${this.transcriptDir}/Transcript_${today}.md`,
        `- Yesterday: ${this.transcriptDir}/Transcript_${yesterday}.md`,
        ``,
        `After reviewing, briefly tell the user what you understand the current work to be.`,
        `=== END STARTUP PROTOCOL ===`,
        ``,
      );
    }

    // State maintenance — from platform config
    if (this.stateMaintenance && this.stateFile) {
      lines.push(
        `=== STATE MAINTENANCE ===`,
        `You are responsible for maintaining ${this.stateFile} (at ${this.folioPath}/${this.stateFile}).`,
        `After completing any significant task, update this file to reflect the new state.`,
        `This includes: sprint progress, completed milestones, changed priorities, new decisions.`,
        `If you don't update it, the next agent session will have stale state.`,
        `=== END STATE MAINTENANCE ===`,
        ``,
      );
    }

    lines.push(
      `SESSION PARAMETERS (from Darkhan platform config — changeable in Settings):`,
      `- Session cycle: ${this.maxSessionMessages} messages`,
      `- Context window: ${this.channelContextMessages} recent messages`,
      `- Transcript depth: ${this.transcriptReadDays} day(s)`,
      ``,
      `Messages come from terminal (private) or chat channels (public).`,
      `Respond directly to the user.`,
    );

    if (stateContent) {
      lines.push(``, `--- CURRENT STATE (${this.stateFile}) ---`, stateContent, `--- END STATE ---`);
    }
    if (channelContext) {
      lines.push(``, `--- CONVERSATION HISTORY (last 3 hours from #command, #claude, #alerts) ---`, channelContext, `--- END CONVERSATION HISTORY ---`);
    }
    if (activityDigest) {
      lines.push(``, `SYSTEM EVENTS (last 6 hours):`, activityDigest);
    }

    return lines.filter(Boolean).join('\n');
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

  /**
   * Cycle a session — close the in-memory session so the next message
   * gets a fresh system prompt with updated context. The SDK session ID
   * is KEPT in stored sessions so it can be resumed after server restarts.
   * The hash-chain activity log preserves full history.
   */
  _cycleSession(userId, entry) {
    const msgCount = entry.messageCount || 0;
    console.log(`[UnifiedClaude] Cycling session for ${userId} (${msgCount} msgs — threshold: ${this.maxSessionMessages})`);

    this._logActivity(userId, 'session_cycled', {
      messageCount: msgCount,
      threshold: this.maxSessionMessages,
      sessionId: entry.sessionId,
    });

    this._postToChannel('chan_system', `[Session cycled for ${userId} after ${msgCount} messages. Next message resumes with recent context.]`);

    // Close in-memory session but KEEP the stored session ID.
    // The SDK session persists server-side — we can resume it after restart.
    // Reset message count so the next resume doesn't immediately re-cycle.
    try { entry.session.close(); } catch {}
    this.sessions.delete(userId);
    if (entry.sessionId) {
      this._storedSessions[userId] = {
        sessionId: entry.sessionId,
        createdAt: this._storedSessions[userId]?.createdAt || Date.now(),
        messageCount: 0, // Reset — cycle is a logical boundary, not a session kill
        lastMessageAt: Date.now(),
      };
      this._saveStoredSessions();
    }
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

  /**
   * Get channel messages from the last N hours across key channels.
   * Time-based instead of count-based — scales with actual activity.
   * Code blocks stripped, thinking messages filtered, capped at maxMessages.
   */
  _getTimedChannelContext(hours = 3, maxMessages = 200) {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve('');

      const since = new Date(Date.now() - hours * 3600000);
      // Format to match SQLite's DATETIME format (no T, no Z)
      const sinceStr = since.toISOString().replace('T', ' ').substring(0, 19);
      const channels = ['chan_command', 'chan_system', 'chan_alerts'];

      this.db.all(
        `SELECT from_user, body, created_at, channel_id FROM messages
         WHERE channel_id IN (${channels.map(() => '?').join(',')})
           AND created_at > ?
         ORDER BY created_at ASC
         LIMIT ?`,
        [...channels, sinceStr, maxMessages],
        (err, rows) => {
          if (err) return reject(err);
          if (!rows || rows.length === 0) return resolve('');

          const lines = [];
          for (const r of rows) {
            let body = r.body || '';
            // Strip code blocks
            body = body.replace(/```[\s\S]*?```/g, '[code block removed]');
            // Skip noise
            if (body === '...thinking' || body.startsWith('...working')) continue;
            // Truncate very long messages
            if (body.length > 1500) body = body.substring(0, 1500) + '... [truncated]';

            const time = (r.created_at || '').substring(11, 19);
            const ch = (r.channel_id || '').replace('chan_', '#');
            lines.push(`[${time}] [${ch}] ${r.from_user}: ${body}`);
          }

          console.log(`[UnifiedClaude] Channel context: ${lines.length} messages from last ${hours}h`);
          resolve(lines.join('\n'));
        }
      );
    });
  }

  /**
   * Fallback: get the last N channel messages by count (when time-based returns nothing).
   * Same formatting and filtering as _getTimedChannelContext.
   */
  _getRecentChannelContext(limit = 100) {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve('');
      const channels = ['chan_command', 'chan_system', 'chan_alerts'];

      this.db.all(
        `SELECT from_user, body, created_at, channel_id FROM messages
         WHERE channel_id IN (${channels.map(() => '?').join(',')})
         ORDER BY created_at DESC
         LIMIT ?`,
        [...channels, limit],
        (err, rows) => {
          if (err) return reject(err);
          if (!rows || rows.length === 0) return resolve('');

          const lines = [];
          for (const r of rows.reverse()) {
            let body = r.body || '';
            body = body.replace(/```[\s\S]*?```/g, '[code block removed]');
            if (body === '...thinking' || body.startsWith('...working')) continue;
            if (body.length > 1500) body = body.substring(0, 1500) + '... [truncated]';

            const time = (r.created_at || '').substring(11, 19);
            const ch = (r.channel_id || '').replace('chan_', '#');
            lines.push(`[${time}] [${ch}] ${r.from_user}: ${body}`);
          }

          console.log(`[UnifiedClaude] Channel context (fallback): ${lines.length} messages by count`);
          resolve(lines.join('\n'));
        }
      );
    });
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
        executionTier: entry.executionTier || 'supervised',
      });
    }
    return { activeSessions: active.length, sessions: active, storedSessions: Object.keys(this._storedSessions).length };
  }

  async shutdown() {
    for (const [userId] of this.sessions) await this.closeSession(userId);
  }
}

module.exports = { UnifiedClaudeSession, classifyToolCall, isTierApproved, TOOL_CLASSIFICATION };
