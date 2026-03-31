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
const { v4: uuidv4 } = require('uuid');

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

    if (mode === 'claude' && this.unifiedClaude) {
      // UNIFIED MODE: Use the shared SDK session
      await this._spawnUnifiedClaude(socket, userId, key, cols, rows);
    } else if (mode === 'claude') {
      // Fallback: raw PTY if unified session not available
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
      const entry = await this.unifiedClaude.getOrCreateSession(userId);
      const subscriberId = `terminal_${key}`;

      // Subscribe to stream events and render as terminal text
      this.unifiedClaude.subscribe(userId, subscriberId, 'terminal', (event) => {
        switch (event.type) {
          case 'text_delta':
            socket.emit('terminal:output', { key, data: event.text });
            break;
          case 'assistant_message':
            // Full message — already streamed via deltas, just add newline
            socket.emit('terminal:output', { key, data: '\r\n' });
            break;
          case 'tool_summary':
            socket.emit('terminal:output', { key,
              data: `\x1b[36m[Tool] ${event.text}\x1b[0m\r\n` });
            break;
          case 'system':
            socket.emit('terminal:output', { key,
              data: `\x1b[33m${event.text}\x1b[0m\r\n` });
            break;
          case 'result':
            socket.emit('terminal:output', { key,
              data: `\r\n\x1b[32m> \x1b[0m` }); // Show prompt
            break;
          case 'error':
            socket.emit('terminal:output', { key,
              data: `\x1b[31m${event.text}\x1b[0m\r\n` });
            break;
        }
      });

      // Handle terminal input — send to unified session
      this.sessions.set(key, {
        userId,
        socketId: socket.id,
        socket,
        mode: 'claude',
        unified: true,
        subscriberId,
        disconnectTimer: null,
        startTime: new Date().toISOString(),
        // Input buffer for building complete messages (enter key = send)
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
      command = 'claude';
      const allowedTools = this.config.terminal?.allowedTools ||
        'Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch,Agent';
      args = ['--allowedTools', allowedTools];
      label = 'Claude Code (standalone)';
    } else {
      command = process.env.SHELL || '/bin/zsh';
      args = [];
      label = 'Shell';
    }

    // [P0-H1 FIX] Shell PTY gets a filtered environment — no secrets.
    // Same whitelist as worker shell processes. Prevents API key and SESSION_SECRET
    // exposure if a web session is compromised.
    const safeEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      LANG: process.env.LANG || 'en_US.UTF-8',
      USER: process.env.USER,
      TERM: 'xterm-256color',
      SHELL: process.env.SHELL || '/bin/zsh',
      TMPDIR: process.env.TMPDIR,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    };
    // Claude Code mode needs Anthropic auth to function
    if (mode === 'claude') {
      if (process.env.ANTHROPIC_API_KEY) safeEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      // Claude Code needs HOME for ~/.claude config
    }

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: safeEnv,
      });
    } catch (err) {
      console.error(`[Terminal] Failed to spawn ${label} for ${userId}:`, err.message);
      socket.emit('terminal:error', { key, message: `Failed to start ${label}: ${err.message}` });
      return;
    }

    const dataHandler = ptyProcess.onData((data) => {
      socket.emit('terminal:output', { key, data });
    });

    const exitHandler = ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[Terminal] ${label} for ${userId} exited (code=${exitCode}, signal=${signal})`);
      socket.emit('terminal:exit', { key, exitCode, signal });
      this.sessions.delete(key);
      this._postToChannel('chan_claude',
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

    this._postToChannel('chan_claude', `[Terminal] ${label} session started by ${userId}`);
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

        if (message.length > 0) {
          if (message === '/quit' || message === '/exit') {
            this._kill(key, 'user_quit');
            session.socket.emit('terminal:exit', { key, exitCode: 0, signal: null });
            return;
          }
          this.unifiedClaude.sendFromTerminal(session.userId, message);
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
        console.log(`[Terminal] User ${userId} disconnected — 30s grace period for ${key}`);
        session.disconnectTimer = setTimeout(() => {
          console.log(`[Terminal] Grace period expired for ${key} — killing PTY`);
          this._kill(key, 'disconnect_timeout');
        }, 30000);
      }
    }
  }

  /**
   * Bridge: Post a message to a Darkhan channel.
   */
  _postToChannel(channelId, body) {
    if (!this.db) return;
    const id = uuidv4();
    this.db.run(
      `INSERT INTO messages (id, channel_id, from_user, body, priority, type) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, channelId, 'system_terminal', body, 'low', 'status'],
      (err) => {
        if (err) {
          console.error(`[Terminal] Failed to post to ${channelId}:`, err.message);
          return;
        }
        // Emit via Socket.IO so connected clients see it in real-time
        if (this.io) {
          this.io.to(channelId).emit('new_message', {
            id, channel_id: channelId, from_user: 'system_terminal',
            body, priority: 'low', type: 'status',
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
