/**
 * Darkhan — Terminal Relay Service
 *
 * Manages terminal sessions inside the Darkhan web UI.
 * Supports two modes:
 *   - 'claude': Full Claude Code session (xterm.js + node-pty + claude CLI)
 *   - 'shell': General-purpose shell (bash/zsh) for system commands, SSH, etc.
 *
 * Bridge: Terminal sessions post events to Darkhan channels so agents and
 * humans can see what's happening. Claude sessions get recent channel context
 * injected via --append-system-prompt.
 *
 * Architecture:
 *   Browser (xterm.js) <--Socket.IO /terminal--> Server (node-pty) <--stdin/stdout--> CLI process
 */

const pty = require('node-pty');
const os = require('os');
const crypto = require('crypto');

class TerminalRelay {
  constructor({ io, db, config, activityLog, unifiedClaude }) {
    this.sessions = new Map(); // sessionKey -> { pty, socketId, socket, disconnectTimer, mode, ... }
    this.activityLog = activityLog;
    this.config = config;
    this.db = db;
    this.io = io;
    this.unifiedClaude = unifiedClaude;

    // Create the /terminal namespace
    this.nsp = io.of('/terminal');
    this.nsp.on('connection', (socket) => this._onConnection(socket));
  }

  _onConnection(socket) {
    const user = socket.user;
    if (!user) {
      socket.disconnect(true);
      return;
    }

    const userId = user.id;
    console.log(`[Terminal] User ${userId} connected (socket ${socket.id})`);

    // If user has an existing session with a disconnect timer, cancel it and reattach
    for (const [key, session] of this.sessions) {
      if (session.userId === userId && session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
        session.disconnectTimer = null;
        session.socket = socket;
        session.socketId = socket.id;
        if (session.pty && session.dataHandler) {
          session.dataHandler.dispose();
        }
        if (session.pty) {
          session.dataHandler = session.pty.onData((data) => {
            socket.emit('terminal:output', { key, data });
          });
          socket.emit('terminal:restored', { key, mode: session.mode });
        }
      }
    }

    socket.on('terminal:spawn', (opts) => this._spawn(socket, userId, opts || {}));
    socket.on('terminal:input', ({ key, data }) => this._input(key || userId, data));
    socket.on('terminal:resize', ({ key, cols, rows }) => this._resize(key || userId, cols, rows));
    socket.on('terminal:kill', ({ key } = {}) => this._kill(key || userId, 'user_requested'));
    socket.on('disconnect', () => this._onDisconnect(userId, socket.id));
  }

  async _spawn(socket, userId, opts) {
    const mode = opts.mode || 'claude'; // 'claude' or 'shell'
    const key = opts.key || `${userId}_${mode}`;
    const cols = opts.cols || 120;
    const rows = opts.rows || 30;
    const cwd = opts.cwd || process.env.HOME;

    // Kill existing session with same key
    this._kill(key, 'new_spawn');

    if (mode === 'claude') {
      // Full Claude Code CLI via PTY — same capabilities as standalone terminal
      // (MCP tools, hooks, Monitor, full environment). The unified SDK session
      // is available for chat @claude routing but terminals always get the real CLI.
      await this._spawnPty(socket, userId, key, 'claude', cols, rows, cwd);
    } else {
      // Shell mode: always raw PTY
      await this._spawnPty(socket, userId, key, 'shell', cols, rows, cwd);
    }
  }

  /**
   * Spawn a unified Claude session — shares context with chat @claude.
   */
  async _spawnUnifiedClaude(socket, userId, key, cols, rows) {
    try {
      // Don't eagerly create/resume the session — it will be created on first
      // terminal input (via sendFromTerminal → getOrCreateSession) or on first
      // chat message (via sendFromChat → getOrCreateSession). This prevents
      // orphan sessions from spawning on server startup before anyone types.
      const subscriberId = `terminal_${key}`;

      // Subscribe to stream events and render as terminal text
      // Tool calls collapse into a single spinner line to keep context visible
      const toolState = { tools: [], spinnerActive: false };
      const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let spinnerIdx = 0;
      let spinnerInterval = null;

      const startSpinner = () => {
        if (spinnerInterval) return;
        toolState.spinnerActive = true;
        spinnerInterval = setInterval(() => {
          spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
          const frame = spinnerFrames[spinnerIdx];
          const toolList = toolState.tools.slice(-6).join(', ');
          // \r moves to start of line, \x1b[2K clears the line
          socket.emit('terminal:output', { key,
            data: `\r\x1b[2K\x1b[90m  ${frame} Thinking... (${toolList})\x1b[0m` });
        }, 120);
      };

      const stopSpinner = () => {
        if (spinnerInterval) {
          clearInterval(spinnerInterval);
          spinnerInterval = null;
        }
        if (toolState.spinnerActive) {
          // Clear the spinner line and add breathing room
          socket.emit('terminal:output', { key, data: `\r\x1b[2K\r\n` });
          toolState.spinnerActive = false;
          toolState.tools = [];
        }
      };

      // Store the callback — will be attached lazily on first terminal input
      let lastEventType = null;
      const subscriberCallback = (event) => {
        switch (event.type) {
          case 'assistant_message': {
            stopSpinner();
            const text = (event.text || '').replace(/\n/g, '\r\n');
            if (text.length > 0) {
              // Add a blank line before text if coming from a different event type
              const spacer = (lastEventType && lastEventType !== 'assistant_message') ? '\r\n' : '';
              socket.emit('terminal:output', { key, data: spacer + text + '\r\n' });
            }
            lastEventType = 'assistant_message';
            break;
          }
          case 'tool_summary': {
            const toolName = (event.text || '').split('(')[0];
            // Add a blank line before tool calls if coming from text output
            if (lastEventType === 'assistant_message' && !toolState.spinnerActive) {
              socket.emit('terminal:output', { key, data: '\r\n' });
            }
            toolState.tools.push(toolName);
            startSpinner();
            lastEventType = 'tool_summary';
            break;
          }
          case 'result':
            stopSpinner();
            socket.emit('terminal:output', { key,
              data: `\r\n\x1b[32m> \x1b[0m` });
            lastEventType = 'result';
            break;
          case 'error':
            stopSpinner();
            socket.emit('terminal:output', { key,
              data: `\r\n\x1b[31m${(event.text || '').replace(/\n/g, '\r\n')}\x1b[0m\r\n\r\n` });
            lastEventType = 'error';
            break;
          case 'permission_prompt':
            stopSpinner();
            socket.emit('terminal:output', { key, data: '\r\n' + (event.text || '') });
            lastEventType = 'permission_prompt';
            break;
        }
      };

      // Handle terminal input — send to unified session
      // Eagerly resume/create the unified session so the terminal subscriber
      // attaches immediately — otherwise the user won't see thinking/tool output
      // until someone sends a chat message (which triggers getOrCreateSession).
      let alreadyAttached = false;
      try {
        await this.unifiedClaude.getOrCreateSession(userId);
        this.unifiedClaude.subscribe(userId, subscriberId, 'terminal', subscriberCallback);
        alreadyAttached = true;
      } catch (err) {
        console.warn(`[Terminal] Could not eagerly create session for ${userId}: ${err.message}`);
        this.unifiedClaude.registerPendingSubscriber(userId, subscriberId, 'terminal', subscriberCallback);
      }

      this.sessions.set(key, {
        userId,
        socketId: socket.id,
        socket,
        mode: 'claude',
        unified: true,
        subscriberId,
        subscriberCallback,
        subscriberAttached: alreadyAttached,
        disconnectTimer: null,
        startTime: new Date().toISOString(),
        inputBuffer: '',
      });

      if (this.activityLog) {
        try {
          this.activityLog.append({
            actor: userId,
            action: 'terminal_session_started',
            details: JSON.stringify({ mode: 'claude', unified: true }),
          });
        } catch {}
      }

      console.log(`[Terminal] Unified Claude session for ${userId}`);
      socket.emit('terminal:ready', { key, mode: 'claude' });
      socket.emit('terminal:output', { key,
        data: '\x1b[1;36mDarkhan Unified Terminal\x1b[0m \u2014 Claude Code (shared context with chat)\r\n' +
              '\x1b[90mThis session shares context with @claude in channels.\x1b[0m\r\n\r\n' +
              '\x1b[32m> \x1b[0m' });
    } catch (err) {
      console.error(`[Terminal] Failed to create unified Claude session:`, err.message);
      socket.emit('terminal:error', { key, message: `Failed to start Claude: ${err.message}` });
    }
  }

  /**
   * Spawn a raw PTY session (for shell mode or Claude fallback).
   */
  async _spawnPty(socket, userId, key, mode, cols, rows, cwd) {
    let command, args, label;

    if (mode === 'claude') {
      // Resolve claude binary — launchd PATH may not include ~/.local/bin
      const fs = require('fs');
      const HOME = process.env.HOME || '';
      const claudePaths = [
        `${HOME}/.local/bin/claude`,
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
      ];
      command = claudePaths.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'claude';
      args = [];
      label = 'Claude Code';
    } else {
      command = process.env.SHELL || '/bin/zsh';
      args = [];
      label = 'Shell';
    }

    let env;
    if (mode === 'claude') {
      // Claude Code CLI needs the full environment for MCP servers, hooks,
      // and tool access. Strip only Darkhan's internal secrets.
      const { SESSION_SECRET, DB_ENCRYPTION_KEY, ...parentEnv } = process.env;
      // Ensure PATH includes common tool locations (launchd strips these)
      const HOME = process.env.HOME || '';
      const extraPaths = [`${HOME}/.local/bin`, `${HOME}/.bun/bin`, '/opt/homebrew/bin'];
      const currentPath = parentEnv.PATH || '/usr/bin:/bin';
      const fullPath = [...extraPaths, ...currentPath.split(':')].filter((v, i, a) => a.indexOf(v) === i).join(':');
      env = { ...parentEnv, TERM: 'xterm-256color', PATH: fullPath };
    } else {
      // [P0-H1 FIX] Shell PTY gets a filtered environment — no secrets.
      // Prevents API key and SESSION_SECRET exposure if compromised.
      env = {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        LANG: process.env.LANG || 'en_US.UTF-8',
        USER: process.env.USER,
        TERM: 'xterm-256color',
        SHELL: process.env.SHELL || '/bin/zsh',
        TMPDIR: process.env.TMPDIR,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      };
    }

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });
    } catch (err) {
      if (mode === 'claude') {
        // Fallback: spawn via interactive shell (handles symlinks, PATH edge cases)
        console.warn(`[Terminal] Direct spawn failed: ${err.message} — trying shell wrapper`);
        try {
          const shellCmd = args.length ? `${command} ${args.join(' ')}` : command;
          ptyProcess = pty.spawn('/bin/zsh', ['-ilc', shellCmd], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
          });
        } catch (fallbackErr) {
          console.error(`[Terminal] Shell fallback also failed for ${userId}:`, fallbackErr.message);
          socket.emit('terminal:error', { key, message: `Failed to start ${label}: ${fallbackErr.message}` });
          return;
        }
      } else {
        console.error(`[Terminal] Failed to spawn ${label} for ${userId}:`, err.message);
        socket.emit('terminal:error', { key, message: `Failed to start ${label}: ${err.message}` });
        return;
      }
    }

    const dataHandler = ptyProcess.onData((data) => {
      socket.emit('terminal:output', { key, data });
    });

    const exitHandler = ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[Terminal] ${label} for ${userId} exited (code=${exitCode}, signal=${signal})`);
      socket.emit('terminal:exit', { key, exitCode, signal });
      this.sessions.delete(key);
      this._postToChannel('chan_system',
        `[Terminal] ${label} session ended for ${userId} (exit code: ${exitCode})`);
      if (this.activityLog) {
        try {
          this.activityLog.append({
            actor: userId, action: 'terminal_session_ended',
            details: JSON.stringify({ mode, exitCode, signal }),
          });
        } catch {}
      }
    });

    this.sessions.set(key, {
      pty: ptyProcess, userId, socketId: socket.id, socket, mode,
      unified: false, disconnectTimer: null, dataHandler, exitHandler,
      startTime: new Date().toISOString(),
    });

    if (this.activityLog) {
      try {
        this.activityLog.append({
          actor: userId, action: 'terminal_session_started',
          details: JSON.stringify({ mode, cols, rows, cwd }),
        });
      } catch {}
    }

    this._postToChannel('chan_system', `[Terminal] ${label} session started by ${userId}`);
    console.log(`[Terminal] ${label} spawned for ${userId} (${cols}x${rows})`);
    socket.emit('terminal:ready', { key, mode });
  }

  _input(key, data) {
    const session = this.sessions.get(key);
    if (!session) return;

    if (session.unified && this.unifiedClaude) {
      // Unified mode: buffer input, send on Enter
      // Echo the character back to the terminal
      if (data === '\r' || data === '\n') {
        const message = session.inputBuffer.trim();
        session.inputBuffer = '';
        session.socket.emit('terminal:output', { key, data: '\r\n' });

        // Check if there's a pending permission to resolve
        if (message.length > 0 && this.unifiedClaude.hasPendingPermission(session.userId)) {
          const lower = message.toLowerCase();
          if (lower === 'y' || lower === 'yes' || lower === 'approve') {
            this.unifiedClaude.resolvePermission(session.userId, 'allow');
            session.socket.emit('terminal:output', { key, data: '\x1b[32m✓ Allowed\x1b[0m\r\n' });
          } else if (lower === 'a' || lower === 'always') {
            this.unifiedClaude.resolvePermission(session.userId, 'always');
            session.socket.emit('terminal:output', { key, data: '\x1b[36m✓ Always allowed\x1b[0m\r\n' });
          } else if (lower === 'n' || lower === 'no' || lower === 'deny') {
            this.unifiedClaude.resolvePermission(session.userId, 'deny');
            session.socket.emit('terminal:output', { key, data: '\x1b[31m✗ Denied\x1b[0m\r\n' });
          } else {
            session.socket.emit('terminal:output', { key, data: '\x1b[33mType y/n/a (allow, deny, always allow)\x1b[0m\r\n\x1b[33m? \x1b[0m' });
          }
          return;
        }

        if (message.length > 0) {
          if (message === '/quit' || message === '/exit') {
            this._kill(key, 'user_quit');
            session.socket.emit('terminal:exit', { key, exitCode: 0, signal: null });
            return;
          }
          // Ensure subscriber is attached (lazy — session may not exist until first send)
          if (session.subscriberId && !session.subscriberAttached) {
            this.unifiedClaude.getOrCreateSession(session.userId).then(() => {
              this.unifiedClaude.subscribe(session.userId, session.subscriberId, 'terminal', session.subscriberCallback);
              session.subscriberAttached = true;
              this.unifiedClaude.sendFromTerminal(session.userId, message);
            });
          } else {
            this.unifiedClaude.sendFromTerminal(session.userId, message);
          }
        } else {
          session.socket.emit('terminal:output', { key, data: '\x1b[32m> \x1b[0m' });
        }
      } else if (data === '\x7f' || data === '\b') {
        // Backspace
        if (session.inputBuffer.length > 0) {
          session.inputBuffer = session.inputBuffer.slice(0, -1);
          session.socket.emit('terminal:output', { key, data: '\b \b' });
        }
      } else if (data === '\x03') {
        // Ctrl+C — clear input
        session.inputBuffer = '';
        session.socket.emit('terminal:output', { key, data: '^C\r\n\x1b[32m> \x1b[0m' });
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        // Printable character
        session.inputBuffer += data;
        session.socket.emit('terminal:output', { key, data });
      }
    } else if (session.pty) {
      // Raw PTY mode: pass through directly
      session.pty.write(data);
    }
  }

  _resize(key, cols, rows) {
    const session = this.sessions.get(key);
    if (session && session.pty) {
      try { session.pty.resize(cols, rows); } catch {}
    }
  }

  _kill(key, reason) {
    const session = this.sessions.get(key);
    if (session) {
      if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
      if (session.unified && this.unifiedClaude && session.subscriberId) {
        // Unsubscribe from unified session (don't close it — chat may still use it)
        this.unifiedClaude.unsubscribe(session.userId, session.subscriberId);
      }
      if (session.dataHandler) session.dataHandler.dispose();
      if (session.exitHandler) session.exitHandler.dispose();
      if (session.pty) {
        try { session.pty.kill(); } catch {}
      }
      this.sessions.delete(key);
      if (reason !== 'new_spawn') {
        console.log(`[Terminal] Session ${key} killed (${reason})`);
      }
    }
  }

  _onDisconnect(userId, socketId) {
    for (const [key, session] of this.sessions) {
      if (session.userId === userId && session.socketId === socketId) {
        console.log(`[Terminal] User ${userId} disconnected — 120s grace period for ${key}`);
        session.disconnectTimer = setTimeout(() => {
          console.log(`[Terminal] Grace period expired for ${key} — killing subscriber`);
          this._kill(key, 'disconnect_timeout');
        }, 120000);
      }
    }
  }

  /**
   * Bridge: Post a message to a Darkhan channel.
   */
  _postToChannel(channelId, body, fromUser = 'system_terminal') {
    if (!this.db) return;
    const id = crypto.randomUUID();
    const msgType = fromUser.startsWith('user_') ? 'message' : 'status';
    this.db.run(
      `INSERT INTO messages (id, channel_id, from_user, body, priority, type) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, channelId, fromUser, body, 'normal', msgType],
      (err) => {
        if (err) {
          console.error(`[Terminal] Failed to post to ${channelId}:`, err.message);
          return;
        }
        if (this.io) {
          this.io.to(channelId).emit('new_message', {
            id, channel_id: channelId, from_user: fromUser,
            body, priority: 'normal', type: msgType,
            created_at: new Date().toISOString(),
          });
        }
      }
    );
  }

  /**
   * Bridge: Get recent messages from a channel for Claude context injection.
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
          const msgs = rows.reverse().map(r =>
            `[${r.created_at}] ${r.from_user}: ${r.body.substring(0, 300)}`
          ).join('\n');
          resolve(msgs);
        }
      );
    });
  }

  async shutdown() {
    for (const [key, session] of this.sessions) {
      if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
      if (session.dataHandler) session.dataHandler.dispose();
      if (session.exitHandler) session.exitHandler.dispose();
      if (session.pty) {
        try { session.pty.kill(); } catch {}
      }
    }
    this.sessions.clear();
    console.log('[Terminal] All PTY sessions terminated');
  }

  getStatus() {
    const active = [];
    for (const [key, session] of this.sessions) {
      active.push({
        key,
        userId: session.userId,
        mode: session.mode,
        startTime: session.startTime,
        hasTimer: !!session.disconnectTimer,
      });
    }
    return { activeSessions: active.length, sessions: active };
  }
}

module.exports = { TerminalRelay };
