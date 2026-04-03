/**
 * Darkhan — Federated Worker Runtime
 *
 * Extends WorkerRuntime for remote execution. Workers run on a remote node
 * and communicate with the main Darkhan server via HTTP API instead of
 * direct database/socket access.
 *
 * Used on a remote node to run federated workers against the main Darkhan hub.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { WorkerRuntime } = require('./worker-runtime');

class FederatedWorkerRuntime extends WorkerRuntime {
  /**
   * @param {Object} opts
   * @param {string} opts.remoteHost - Full URL of the Darkhan server (e.g., 'http://192.168.1.100:3001')
   * @param {Object} opts.apiKeys - Map of agent_id -> API key (e.g., { agent_chief: 'dk_agent_xxx' })
   * @param {Object} opts.llmService - LLMService instance
   * @param {Object} opts.config - darkhan.config.json contents
   * @param {Object} opts.activityLog - Activity log interface
   * @param {Object} opts.costTracker - Cost tracker interface
   */
  constructor({ remoteHost, apiKeys, llmService, config, activityLog, costTracker }) {
    // Pass db: null and io: null — federated runtime uses HTTP, not local DB/socket
    super({
      llmService,
      db: null,
      io: null,
      config,
      activityLog,
      costTracker,
      securityService: null,
    });

    this.remoteHost = remoteHost.replace(/\/+$/, ''); // strip trailing slash
    this.apiKeys = apiKeys || {};
    this._pollingIntervals = [];
    this._lastSeenTimestamps = {}; // channelId -> ISO timestamp of last seen message

    // [HARDENING-7] Interim federation gate — require explicit peer approval.
    // Without FEDERATION_APPROVED_PEERS, federation is disabled entirely.
    // This prevents unauthorized nodes from connecting before the full Mokume
    // peer approval system is implemented.
    const approvedPeers = (process.env.FEDERATION_APPROVED_PEERS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (approvedPeers.length === 0) {
      console.error('[FederatedRuntime] No approved federation peers configured.');
      console.error('[FederatedRuntime] Set FEDERATION_APPROVED_PEERS=<fingerprint1,fingerprint2> to enable.');
      console.error('[FederatedRuntime] Federation is DISABLED until peers are explicitly approved.');
      this._federationDisabled = true;
    } else {
      this._approvedPeers = new Set(approvedPeers);
      this._federationDisabled = false;
      console.log(`[FederatedRuntime] ${approvedPeers.length} approved peer(s) configured`);
    }

    // [DARKHAN SECURITY] mTLS certificate loading
    // If TLS config is provided, load CA + client cert/key for mutual authentication.
    // Both sides verify each other — the server checks the client cert, the client checks the server cert.
    this._tlsOptions = null;
    const tlsConfig = config?.tls;
    if (tlsConfig?.enabled) {
      const resolvePath = (p) => p.replace('~', process.env.HOME);
      try {
        this._tlsOptions = {
          ca: fs.readFileSync(resolvePath(tlsConfig.ca)),
          cert: fs.readFileSync(resolvePath(tlsConfig.cert)),
          key: fs.readFileSync(resolvePath(tlsConfig.key)),
          rejectUnauthorized: true, // Enforce CA verification
        };
        console.log('[FederatedRuntime] mTLS certificates loaded — mutual authentication enabled');
      } catch (e) {
        console.error(`[FederatedRuntime] FATAL: Could not load TLS certificates: ${e.message}`);
        process.exit(1);
      }
    }

    // [DARKHAN SECURITY] TLS enforcement for federation
    // HTTP is acceptable on Tailscale networks (WireGuard-encrypted). For non-Tailscale
    // deployments, require HTTPS or explicit opt-in via FEDERATION_ALLOW_HTTP=true.
    if (this.remoteHost.startsWith('http://')) {
      if (this._tlsOptions) {
        console.warn('[FederatedRuntime] mTLS certs loaded but remote host is HTTP — certs will not be used. ' +
          'Switch REMOTE_HOST to https:// to enable mutual authentication.');
      }
      if (process.env.FEDERATION_ALLOW_HTTP === 'true') {
        console.warn('[FederatedRuntime] WARNING: Federation using unencrypted HTTP. ' +
          'This is acceptable on Tailscale networks. For non-Tailscale deployments, use HTTPS.');
      } else {
        console.error('[FederatedRuntime] FATAL: Federation target uses HTTP (unencrypted). ' +
          'Set FEDERATION_ALLOW_HTTP=true if running on a Tailscale/WireGuard network, ' +
          'or use an https:// URL for the remote host.');
        process.exit(1);
      }
    }
  }

  /**
   * Get the API key for a given agent. Falls back to first available key.
   */
  _getApiKey(agentId) {
    return this.apiKeys[agentId] || Object.values(this.apiKeys)[0] || '';
  }

  /**
   * Make an HTTP request to the remote Darkhan server.
   * Uses Node.js built-in http/https modules (no external dependencies).
   *
   * @param {string} method - HTTP method
   * @param {string} urlPath - Path relative to remoteHost (e.g., '/api/messages')
   * @param {Object|null} body - JSON body for POST requests
   * @param {string} apiKey - X-API-Key header value
   * @returns {Promise<Object>} Parsed JSON response
   */
  _httpRequest(method, urlPath, body, apiKey) {
    // [HARDENING-7] Block all federation traffic if no peers approved
    if (this._federationDisabled) {
      return Promise.reject(new Error('Federation disabled: no approved peers configured (FEDERATION_APPROVED_PEERS)'));
    }

    return new Promise((resolve, reject) => {
      const fullUrl = new URL(urlPath, this.remoteHost);
      const isHttps = fullUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const payload = body ? JSON.stringify(body) : null;

      const options = {
        hostname: fullUrl.hostname,
        port: fullUrl.port || (isHttps ? 443 : 80),
        path: fullUrl.pathname + fullUrl.search,
        method,
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      };

      // [DARKHAN SECURITY] mTLS: attach client certificates for mutual authentication
      if (isHttps && this._tlsOptions) {
        options.ca = this._tlsOptions.ca;
        options.cert = this._tlsOptions.cert;
        options.key = this._tlsOptions.key;
        options.rejectUnauthorized = this._tlsOptions.rejectUnauthorized;
      }

      if (payload) {
        options.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${parsed.error || data}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`Remote server unreachable: ${e.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out (15s)'));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Override: Post a message to a channel via the remote Darkhan API.
   * The server determines from_user from the API key.
   */
  _postToChannel(channelId, body, fromUser, opts = {}) {
    const apiKey = this._getApiKey(fromUser);
    this._httpRequest('POST', '/api/messages', {
      channel_id: channelId,
      body: body,
    }, apiKey).then(() => {
      // Success — no-op (fire and forget with logging)
    }).catch((err) => {
      console.error(`[FederatedRuntime] POST to ${channelId} failed: ${err.message}`);
    });
  }

  /**
   * Override: Get messages from a channel via the remote Darkhan API.
   */
  async _getMessages(channelId, opts = {}) {
    // Use first available API key for reads
    const apiKey = Object.values(this.apiKeys)[0] || '';
    const params = [`channel=${encodeURIComponent(channelId)}`];
    if (opts.limit) params.push(`limit=${opts.limit}`);
    if (opts.since) params.push(`since=${encodeURIComponent(opts.since)}`);
    const queryPath = `/api/messages?${params.join('&')}`;

    try {
      const result = await this._httpRequest('GET', queryPath, null, apiKey);
      // The API returns { messages: [...], count: N }
      return Array.isArray(result) ? result : (result.messages || []);
    } catch (err) {
      console.error(`[FederatedRuntime] GET messages from ${channelId} failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Override: Create a task via the remote Darkhan API.
   */
  _createTask({ title, assignee, priority = 3, description, createdBy }) {
    const apiKey = this._getApiKey(createdBy);
    this._httpRequest('POST', '/api/tasks', {
      title,
      assignee,
      priority,
      description,
    }, apiKey).catch((err) => {
      console.error(`[FederatedRuntime] Create task failed: ${err.message}`);
    });
  }

  /**
   * Override: Ping health to the remote Darkhan server.
   */
  _pingHealth(agentId, status = 'active') {
    const apiKey = this._getApiKey(agentId);
    this._httpRequest('POST', '/api/health/ping', {
      agent: agentId,
      status,
    }, apiKey).catch((err) => {
      // Health ping failures are non-critical — just log
      console.warn(`[FederatedRuntime] Health ping failed for ${agentId}: ${err.message}`);
    });
  }

  /**
   * Start polling the hub server for new messages across all configured channels.
   * Runs new messages through this.onMessage() for listener matching.
   *
   * @param {number} intervalMs - Polling interval in milliseconds (default: 5000)
   */
  startListenerPolling(intervalMs = 5000) {
    // Gather all unique channels that our workers listen on
    const channels = new Set();
    for (const listener of this.messageListeners) {
      const worker = this.workers.get(listener.workerId);
      if (worker && worker.module) {
        const agentConfig = this.config.team.members.find(m => m.id === listener.workerId);
        if (agentConfig && agentConfig.channels) {
          agentConfig.channels.forEach(ch => channels.add(ch));
        }
      }
    }

    // If no listeners have channels, poll the default set
    if (channels.size === 0) {
      channels.add('chan_command');
      channels.add('chan_coordination');
      channels.add('chan_alerts');
    }

    console.log(`[FederatedRuntime] Starting listener polling (${intervalMs}ms) on: ${[...channels].join(', ')}`);

    // Initialize last-seen timestamps to now so we don't process old messages
    // Use SQLite-compatible format (space between date and time, no 'Z')
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
    for (const ch of channels) {
      this._lastSeenTimestamps[ch] = now;
    }

    const pollCycle = async () => {
      for (const channelId of channels) {
        try {
          const messages = await this._getMessages(channelId, {
            since: this._lastSeenTimestamps[channelId],
            limit: 20,
          });

          if (!messages || messages.length === 0) continue;

          for (const msg of messages) {
            // Update last-seen timestamp (use raw created_at from DB — already in SQLite format)
            const msgTs = msg.created_at || '';
            if (msgTs && msgTs > (this._lastSeenTimestamps[channelId] || '')) {
              this._lastSeenTimestamps[channelId] = msgTs;
            }

            // Route through listener matching
            try {
              await this.onMessage(channelId, msg.from_user, msg.body);
            } catch (e) {
              console.error(`[FederatedRuntime] Listener error on ${channelId}: ${e.message}`);
            }
          }
        } catch (err) {
          // Hub unreachable — log and continue, will retry next cycle
          console.warn(`[FederatedRuntime] Poll failed for ${channelId}: ${err.message}`);
        }
      }
    };

    const interval = setInterval(pollCycle, intervalMs);
    this._pollingIntervals.push(interval);

    // Run first poll immediately
    pollCycle();
  }

  /**
   * Override: Graceful shutdown — also clears polling intervals.
   */
  async shutdown() {
    console.log('[FederatedRuntime] Stopping listener polling...');
    for (const interval of this._pollingIntervals) {
      clearInterval(interval);
    }
    this._pollingIntervals = [];
    await super.shutdown();
  }
}

module.exports = { FederatedWorkerRuntime };
