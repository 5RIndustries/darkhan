/**
 * Darkhan — Remote Terminal Proxy
 *
 * Proxies terminal sessions from the local Darkhan UI to remote nodes
 * over direct Socket.IO connections via mTLS port 3002.
 *
 * Architecture:
 *   Browser (xterm.js) <--Socket.IO /terminal--> RemoteTerminalProxy <--Socket.IO /terminal (mTLS)--> Remote TerminalRelay
 *
 * The remote TerminalRelay sees a normal authenticated client.
 * The browser doesn't know the session is proxied.
 */

const { io: ioClient } = require('socket.io-client');
const fs = require('fs');

// Events forwarded from remote → browser
const REMOTE_TO_BROWSER = [
  'terminal:output',
  'terminal:scrollback',
  'terminal:ready',
  'terminal:restored',
  'terminal:exit',
  'terminal:error'
];

// Events forwarded from browser → remote
const BROWSER_TO_REMOTE = [
  'terminal:input',
  'terminal:resize',
  'terminal:kill'
];

const BROWSER_DISCONNECT_GRACE_MS = 90000; // 90s — remote keeps its own 120s grace
const REMOTE_RECONNECT_ATTEMPTS = 3;
const REMOTE_RECONNECT_DELAY_MS = 5000;

class RemoteTerminalProxy {
  constructor({ io, config, activityLog }) {
    this.config = config;
    this.activityLog = activityLog;
    this.proxySessions = new Map(); // `${userId}:${nodeId}` -> ProxySession

    // Load remote node config
    this.remoteNodes = (config.terminalRelay && config.terminalRelay.remoteNodes) || {};

    // Load mTLS certs for outbound connections
    this.tlsOpts = {};
    if (config.tls && config.tls.enabled) {
      try {
        this.tlsOpts = {
          ca: fs.readFileSync(config.tls.ca),
          cert: fs.readFileSync(config.tls.cert),
          key: fs.readFileSync(config.tls.key),
          rejectUnauthorized: true
        };
      } catch (e) {
        console.warn(`[RemoteProxy] Failed to load TLS certs: ${e.message}`);
      }
    }

    // Register on the /terminal namespace as a second connection listener
    const nsp = io.of('/terminal');
    nsp.on('connection', (socket) => this._onConnection(socket));

    console.log(`[RemoteProxy] Initialized with ${Object.keys(this.remoteNodes).length} remote node(s)`);
  }

  _onConnection(socket) {
    const user = socket.user;
    if (!user) return;

    const userId = user.id;

    // Check for existing proxy sessions to reattach
    for (const [sessionKey, session] of this.proxySessions) {
      if (session.userId === userId && session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
        session.disconnectTimer = null;
        session.browserSocket = socket;
        this._rewireBrowserEvents(session, socket);
        console.log(`[RemoteProxy] Reattached browser for ${sessionKey}`);
      }
    }

    // Listen for remote spawn requests
    socket.on('terminal:spawn', (opts) => {
      if (opts && opts.remote && opts.nodeId) {
        this._proxySpawn(socket, userId, opts);
      }
      // Non-remote spawns are handled by TerminalRelay — we ignore them
    });

    socket.on('disconnect', () => {
      this._onBrowserDisconnect(userId, socket.id);
    });
  }

  async _proxySpawn(browserSocket, userId, opts) {
    const { nodeId, mode, cols, rows } = opts;
    const sessionKey = `${userId}:${nodeId}`;

    // Check if we already have an active proxy session
    const existing = this.proxySessions.get(sessionKey);
    if (existing && existing.remoteSocket && existing.remoteSocket.connected) {
      console.log(`[RemoteProxy] Reusing existing proxy session for ${sessionKey}`);
      existing.browserSocket = browserSocket;
      this._rewireBrowserEvents(existing, browserSocket);
      // Ask remote to restore if possible by re-emitting spawn
      existing.remoteSocket.emit('terminal:spawn', {
        mode: mode || 'claude',
        cols: cols || 120,
        rows: rows || 30
      });
      return;
    }

    // Look up remote node config
    const nodeConfig = this.remoteNodes[nodeId];
    if (!nodeConfig) {
      browserSocket.emit('terminal:error', {
        key: `remote:${nodeId}`,
        message: `Unknown remote node: ${nodeId}`
      });
      return;
    }

    // Get API key from env
    const apiKey = process.env[nodeConfig.apiKeyEnvVar];
    if (!apiKey || apiKey.startsWith('PLACEHOLDER')) {
      browserSocket.emit('terminal:error', {
        key: `remote:${nodeId}`,
        message: `No API key configured for ${nodeConfig.label} (${nodeConfig.apiKeyEnvVar})`
      });
      return;
    }

    console.log(`[RemoteProxy] Connecting to ${nodeConfig.label} at ${nodeConfig.url}`);

    try {
      const remoteSocket = ioClient(`${nodeConfig.url}/terminal`, {
        auth: { apiKey },
        ...this.tlsOpts,
        reconnection: false,
        transports: ['websocket'],
        timeout: 10000
      });

      const session = {
        userId,
        nodeId,
        nodeLabel: nodeConfig.label,
        browserSocket,
        remoteSocket,
        disconnectTimer: null,
        remoteListeners: [],
        browserListeners: []
      };

      this.proxySessions.set(sessionKey, session);

      // Handle remote connection success
      remoteSocket.on('connect', () => {
        console.log(`[RemoteProxy] Connected to ${nodeConfig.label}`);
        this._wireEvents(session);

        // Forward the spawn request to the remote
        remoteSocket.emit('terminal:spawn', {
          mode: mode || 'claude',
          cols: cols || 120,
          rows: rows || 30
        });

        if (this.activityLog) {
          this.activityLog.append(
            'system',
            'remote_terminal_connected',
            nodeId,
            { userId, label: nodeConfig.label }
          ).catch(() => {});
        }
      });

      // Handle remote connection failure
      remoteSocket.on('connect_error', (err) => {
        console.error(`[RemoteProxy] Failed to connect to ${nodeConfig.label}: ${err.message}`);
        browserSocket.emit('terminal:error', {
          key: `remote:${nodeId}`,
          message: `Cannot reach ${nodeConfig.label}: ${err.message}`
        });
        this.proxySessions.delete(sessionKey);
      });

      // Handle remote disconnect mid-session
      remoteSocket.on('disconnect', (reason) => {
        console.warn(`[RemoteProxy] Remote ${nodeConfig.label} disconnected: ${reason}`);
        browserSocket.emit('terminal:output', {
          key: `remote:${nodeId}`,
          data: `\r\n\x1b[33m[Remote connection to ${nodeConfig.label} lost — ${reason}]\x1b[0m\r\n`
        });

        this._attemptRemoteReconnect(session, nodeConfig, apiKey, { mode, cols, rows });
      });

    } catch (err) {
      browserSocket.emit('terminal:error', {
        key: `remote:${nodeId}`,
        message: `Proxy error: ${err.message}`
      });
    }
  }

  _wireEvents(session) {
    // Clean up any previous listeners
    this._cleanupListeners(session);

    const { remoteSocket, browserSocket, nodeId } = session;

    // Remote → Browser
    for (const event of REMOTE_TO_BROWSER) {
      const handler = (data) => {
        if (session.browserSocket && session.browserSocket.connected) {
          // Tag the key with remote prefix so client can identify which tab
          if (data && typeof data === 'object') {
            data._remoteNodeId = nodeId;
          }
          session.browserSocket.emit(event, data);
        }
      };
      remoteSocket.on(event, handler);
      session.remoteListeners.push({ event, handler });
    }

    // Browser → Remote
    this._wireBrowserToRemote(session, browserSocket);
  }

  _wireBrowserToRemote(session, browserSocket) {
    // Clean up old browser listeners
    for (const { event, handler } of session.browserListeners) {
      browserSocket.off(event, handler);
    }
    session.browserListeners = [];

    for (const event of BROWSER_TO_REMOTE) {
      const handler = (data) => {
        if (session.remoteSocket && session.remoteSocket.connected) {
          session.remoteSocket.emit(event, data);
        }
      };
      browserSocket.on(event, handler);
      session.browserListeners.push({ event, handler });
    }
  }

  _rewireBrowserEvents(session, newSocket) {
    // Remove listeners from old socket
    for (const { event, handler } of session.browserListeners) {
      if (session.browserSocket && session.browserSocket !== newSocket) {
        session.browserSocket.off(event, handler);
      }
    }
    session.browserSocket = newSocket;
    this._wireBrowserToRemote(session, newSocket);
  }

  _cleanupListeners(session) {
    for (const { event, handler } of session.remoteListeners) {
      session.remoteSocket.off(event, handler);
    }
    session.remoteListeners = [];
    for (const { event, handler } of session.browserListeners) {
      if (session.browserSocket) {
        session.browserSocket.off(event, handler);
      }
    }
    session.browserListeners = [];
  }

  _onBrowserDisconnect(userId, socketId) {
    for (const [sessionKey, session] of this.proxySessions) {
      if (session.userId === userId && session.browserSocket && session.browserSocket.id === socketId) {
        console.log(`[RemoteProxy] Browser disconnected for ${sessionKey}, starting ${BROWSER_DISCONNECT_GRACE_MS / 1000}s grace period`);
        session.disconnectTimer = setTimeout(() => {
          console.log(`[RemoteProxy] Grace period expired for ${sessionKey}, disconnecting remote`);
          this._destroySession(sessionKey);
        }, BROWSER_DISCONNECT_GRACE_MS);
      }
    }
  }

  async _attemptRemoteReconnect(session, nodeConfig, apiKey, spawnOpts) {
    for (let attempt = 1; attempt <= REMOTE_RECONNECT_ATTEMPTS; attempt++) {
      await new Promise(r => setTimeout(r, REMOTE_RECONNECT_DELAY_MS));

      if (!this.proxySessions.has(`${session.userId}:${session.nodeId}`)) {
        return; // Session was cleaned up
      }

      console.log(`[RemoteProxy] Reconnect attempt ${attempt}/${REMOTE_RECONNECT_ATTEMPTS} to ${nodeConfig.label}`);

      if (session.browserSocket && session.browserSocket.connected) {
        session.browserSocket.emit('terminal:output', {
          key: `remote:${session.nodeId}`,
          data: `\x1b[33m[Reconnecting to ${nodeConfig.label}... attempt ${attempt}/${REMOTE_RECONNECT_ATTEMPTS}]\x1b[0m\r\n`
        });
      }

      try {
        const newRemote = ioClient(`${nodeConfig.url}/terminal`, {
          auth: { apiKey },
          ...this.tlsOpts,
          reconnection: false,
          transports: ['websocket'],
          timeout: 10000
        });

        const connected = await new Promise((resolve) => {
          const timer = setTimeout(() => { newRemote.disconnect(); resolve(false); }, 10000);
          newRemote.on('connect', () => { clearTimeout(timer); resolve(true); });
          newRemote.on('connect_error', () => { clearTimeout(timer); resolve(false); });
        });

        if (connected) {
          session.remoteSocket = newRemote;
          this._wireEvents(session);
          newRemote.emit('terminal:spawn', {
            mode: spawnOpts.mode || 'claude',
            cols: spawnOpts.cols || 120,
            rows: spawnOpts.rows || 30
          });

          newRemote.on('disconnect', (reason) => {
            console.warn(`[RemoteProxy] Remote ${nodeConfig.label} disconnected again: ${reason}`);
            if (session.browserSocket && session.browserSocket.connected) {
              session.browserSocket.emit('terminal:output', {
                key: `remote:${session.nodeId}`,
                data: `\r\n\x1b[33m[Remote connection to ${nodeConfig.label} lost again — ${reason}]\x1b[0m\r\n`
              });
            }
          });

          console.log(`[RemoteProxy] Reconnected to ${nodeConfig.label}`);
          return;
        }
      } catch (e) {
        // Continue to next attempt
      }
    }

    // All attempts failed
    if (session.browserSocket && session.browserSocket.connected) {
      session.browserSocket.emit('terminal:output', {
        key: `remote:${session.nodeId}`,
        data: `\x1b[31m[Failed to reconnect to ${nodeConfig.label} after ${REMOTE_RECONNECT_ATTEMPTS} attempts]\x1b[0m\r\n`
      });
    }
  }

  _destroySession(sessionKey) {
    const session = this.proxySessions.get(sessionKey);
    if (!session) return;

    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
    }
    this._cleanupListeners(session);
    if (session.remoteSocket) {
      session.remoteSocket.disconnect();
    }
    this.proxySessions.delete(sessionKey);
    console.log(`[RemoteProxy] Session ${sessionKey} destroyed`);
  }

  getStatus() {
    const sessions = [];
    for (const [key, session] of this.proxySessions) {
      sessions.push({
        key,
        userId: session.userId,
        nodeId: session.nodeId,
        nodeLabel: session.nodeLabel,
        remoteConnected: session.remoteSocket ? session.remoteSocket.connected : false,
        browserConnected: session.browserSocket ? session.browserSocket.connected : false,
        hasDisconnectTimer: !!session.disconnectTimer
      });
    }
    return {
      remoteNodes: Object.entries(this.remoteNodes).map(([id, cfg]) => ({
        id,
        label: cfg.label,
        agentId: cfg.agentId,
        url: cfg.url,
        hasApiKey: !!(process.env[cfg.apiKeyEnvVar] && !process.env[cfg.apiKeyEnvVar].startsWith('PLACEHOLDER'))
      })),
      activeSessions: sessions.length,
      sessions
    };
  }

  shutdown() {
    for (const [key] of this.proxySessions) {
      this._destroySession(key);
    }
  }
}

module.exports = { RemoteTerminalProxy };
