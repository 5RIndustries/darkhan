/**
 * Darkhan — Federation Service
 *
 * Connects this Darkhan instance to a Mokume hub for cross-node
 * message routing, threat propagation, and peer discovery.
 *
 * Activated when config.federation.enabled = true and a hubUrl is set.
 * Uses Ed25519 signing for all outbound messages.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

class FederationService {
  /**
   * @param {Object} opts
   * @param {Object} opts.config - darkhan.config.json
   * @param {Object} opts.db - SQLite database
   * @param {Object} opts.io - Socket.IO instance
   * @param {Object} opts.activityLog - Activity log service
   */
  constructor({ config, db, io, activityLog, workerRuntime, onFederatedMessage }) {
    this.config = config;
    this.db = db;
    this.io = io;
    this.activityLog = activityLog;
    this.workerRuntime = workerRuntime || null;
    this._onFederatedMessage = onFederatedMessage || null;

    const fed = config.federation || {};
    this.enabled = fed.enabled === true;
    this.instanceId = fed.instanceId || 'darkhan-' + crypto.randomBytes(4).toString('hex');
    this.hubUrl = (fed.hubUrl || '').replace(/\/+$/, '');
    this.instanceUrl = fed.instanceUrl || '';
    this._hubToken = fed.hubToken || process.env.HUB_SECRET || '';

    this._connected = false;
    this._heartbeatInterval = null;
    this._pollInterval = null;
    this._lastPollTimestamp = null;
    this._knownPeers = [];

    // Ed25519 identity
    this.publicKey = null;
    this._privateKey = null;
  }

  /**
   * Initialize federation — generate identity, connect to hub, start polling.
   */
  async start() {
    if (!this.enabled) {
      console.log('[Federation] Disabled in config');
      return;
    }

    if (!this.hubUrl) {
      console.warn('[Federation] Enabled but no hubUrl configured — skipping');
      return;
    }

    // Load or generate Ed25519 identity
    this._loadIdentity();

    // Register with hub
    try {
      await this._register();
    } catch (err) {
      console.error(`[Federation] Could not connect to hub at ${this.hubUrl}: ${err.message}`);
      console.error('[Federation] Will retry on next heartbeat cycle');
    }

    // Start heartbeat every 30s
    this._heartbeatInterval = setInterval(() => this._heartbeat(), 30000);

    // Start polling for inbound messages every 3s
    this._startPolling(3000);

    this.activityLog.append({
      actor: 'system',
      action: 'federation_started',
      target: this.hubUrl,
      details: JSON.stringify({ instanceId: this.instanceId, hubUrl: this.hubUrl }),
    });
  }

  /**
   * Relay a message from this Darkhan instance through the Mokume hub.
   */
  async relayMessage({ channel, fromUser, body, to, origin }) {
    if (!this._connected) return;

    const message = {
      channel,
      fromUser,
      body,
      to: to || null,
      origin: origin || 'agent_direct',
      timestamp: new Date().toISOString(),
    };

    const signature = this._sign(message);

    try {
      const result = await this._request('POST', '/api/federation/relay', {
        instanceId: this.instanceId,
        message,
        signature,
      });
      return result;
    } catch (err) {
      console.error(`[Federation] Relay failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Report a threat to the hub for propagation.
   */
  async reportThreat(threat) {
    if (!this._connected) return;

    try {
      await this._request('POST', '/api/federation/threat', {
        instanceId: this.instanceId,
        threat,
      });
    } catch (err) {
      console.error(`[Federation] Threat report failed: ${err.message}`);
    }
  }

  /**
   * Trigger an immediate poll — called by the /api/federation/notify push endpoint.
   */
  _pollNow() {
    if (this._pollFn && this._connected) {
      this._pollFn();
    }
  }

  /**
   * Graceful shutdown.
   */
  async shutdown() {
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    if (this._pollInterval) clearInterval(this._pollInterval);
    this._connected = false;
    console.log('[Federation] Shut down');
  }

  // --- Internal ---

  _loadIdentity() {
    const keyDir = path.join(process.env.HOME, '.mokume');
    const keyFile = path.join(keyDir, 'identity.json');

    if (fs.existsSync(keyFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
        if (data.publicKey && data.privateKey) {
          this.publicKey = data.publicKey;
          this._privateKey = data.privateKey;
          console.log(`[Federation] Identity loaded — ${this.instanceId}`);
          return;
        }
      } catch {}
    }

    // Generate new keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    this.publicKey = publicKey.toString('base64');
    this._privateKey = privateKey.toString('base64');

    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(keyFile, JSON.stringify({
      publicKey: this.publicKey,
      privateKey: this._privateKey,
    }, null, 2), { mode: 0o600 });

    console.log(`[Federation] New identity generated for ${this.instanceId}`);
  }

  _sign(message) {
    const messageBytes = Buffer.from(JSON.stringify(message));
    const keyObj = crypto.createPrivateKey({
      key: Buffer.from(this._privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    return crypto.sign(null, messageBytes, keyObj).toString('base64');
  }

  async _register() {
    const result = await this._request('POST', '/api/federation/register', {
      instanceId: this.instanceId,
      url: this.instanceUrl,
      publicKey: this.publicKey,
    });

    this._connected = true;
    this._knownPeers = result.peers || [];
    // Store hub's public key for deploy command signature verification
    if (result.hubPublicKey) {
      this._hubPublicKey = result.hubPublicKey;
      console.log(`[Federation] Stored hub public key: ${result.hubPublicKey.substring(0, 20)}...`);
    } else {
      console.warn('[Federation] Hub did not return hubPublicKey in registration response');
    }
    console.log(`[Federation] Connected to hub — ${result.peerCount} peer(s) in network`);
    return result;
  }

  async _heartbeat() {
    try {
      if (!this._connected) {
        // Try to reconnect
        console.log('[Federation] Attempting reconnect to hub...');
        await this._register();
        return;
      }

      await this._request('POST', '/api/federation/heartbeat', {
        instanceId: this.instanceId,
        stats: {
          uptime: process.uptime(),
          memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        },
      });
    } catch (err) {
      if (this._connected) {
        console.warn(`[Federation] Lost connection to hub: ${err.message}`);
      } else {
        console.warn(`[Federation] Reconnect failed: ${err.message}`);
      }
      this._connected = false;
    }
  }

  _startPolling(intervalMs) {
    // Start with no timestamp so the first poll catches any pending messages
    this._lastPollTimestamp = null;

    const poll = async () => {
      if (!this._connected) return;

      try {
        let url = `/api/federation/messages?instanceId=${encodeURIComponent(this.instanceId)}&limit=50`;
        if (this._lastPollTimestamp) {
          url += `&since=${encodeURIComponent(this._lastPollTimestamp)}`;
        }
        const result = await this._request('GET', url);

        const messages = result.messages || [];
        if (messages.length === 0) return;

        const ackIds = [];

        for (const msg of messages) {
          if (msg.timestamp > this._lastPollTimestamp) {
            this._lastPollTimestamp = msg.timestamp;
          }
          ackIds.push(msg.id);

          // Insert the federated message into local database
          this._ingestMessage(msg);
        }

        // Acknowledge receipt
        if (ackIds.length > 0) {
          await this._request('DELETE', '/api/federation/messages/ack', {
            instanceId: this.instanceId,
            messageIds: ackIds,
          }).catch(() => {});
        }

        console.log(`[Federation] Ingested ${messages.length} message(s) from hub`);
      } catch {
        // Will retry next cycle
      }
    };

    this._pollFn = poll; // Expose for _pollNow() push trigger
    this._pollInterval = setInterval(poll, intervalMs);
    setTimeout(poll, 1000); // First poll after 1s
  }

  /**
   * Insert a federated message into the local Darkhan database and emit via Socket.IO.
   */
  _ingestMessage(msg) {
    const channelId = msg.channel || 'chan_command';

    // Only ingest messages for channels we're configured to federate
    const fedChannels = this.config?.federation?.channels
      || ['chan_coordination', 'chan_alerts'];
    if (!fedChannels.includes(channelId)) {
      return; // Skip messages for non-federated channels
    }

    const fromUser = `${msg.fromUser}@${msg.from}`;
    const body = msg.body;
    const timestamp = msg.originalTimestamp || msg.timestamp;
    const origin = msg.origin || 'agent_direct';

    // Insert into local messages table
    const sql = `INSERT INTO messages (id, channel_id, from_user, body, created_at, metadata)
                 VALUES (?, ?, ?, ?, ?, ?)`;
    const msgId = `fed_${msg.id}`;
    const metadata = JSON.stringify({ federated: true, source_instance: msg.from, origin });

    this.db.run(sql, [msgId, channelId, fromUser, body, timestamp.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace('Z', ''), metadata], (err) => {
      if (err) {
        // Duplicate or other error — skip
        if (!err.message.includes('UNIQUE constraint')) {
          console.error(`[Federation] Message insert error: ${err.message}`);
        }
        return;
      }

      // Emit to connected clients via Socket.IO (use 'new_message' to match local message events)
      if (this.io) {
        this.io.to(channelId).emit('new_message', {
          id: msgId,
          channel_id: channelId,
          from_user: fromUser,
          body,
          created_at: timestamp,
          federated: true,
          source_instance: msg.from,
          origin,
        });
      }
    });

    // Log to activity
    this.activityLog.append({
      actor: fromUser,
      action: 'federated_message',
      target: channelId,
      details: JSON.stringify({ source: msg.from, messageId: msg.id, origin }),
    });

    // Dispatch to worker listeners so federated messages trigger comms_check, mention, etc.
    // Skip dispatch for auto_responder origin — prevents infinite relay loops
    if (this.workerRuntime && origin !== 'auto_responder') {
      this.workerRuntime.onMessage(channelId, fromUser, body).catch(() => {});
    }

    // FEDERATION NOTIFY — post a notification to the lead agent's channel
    // so the active CLI session sees inbound federated messages without polling.
    // Only notify for non-auto-responder messages (human + agent_direct).
    if (origin !== 'auto_responder') {
      const leadAgentId = this.config?.leadAgent?.agentId || 'agent_claude';
      const leadChannel = 'chan_' + leadAgentId.replace('agent_', '');
      const preview = body.length > 120 ? body.substring(0, 120) + '...' : body;
      const notification = `[Mokume] ${fromUser} in ${channelId}: ${preview}`;
      // Insert notification directly — don't relay it (it's local-only)
      this.db.run(
        'INSERT INTO messages (id, channel_id, from_user, body, priority, type) VALUES (?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), leadChannel, 'agent_darkhan', notification, 'normal', 'notification'],
        (err) => {
          if (!err && this.io) {
            this.io.to(leadChannel).emit('new_message', {
              id: crypto.randomUUID(),
              channel_id: leadChannel,
              from_user: 'agent_darkhan',
              body: notification,
              type: 'notification',
              created_at: new Date().toISOString(),
            });
          }
        }
      );
    }

    // Dispatch to auto-responder and unified session injection (server.js callback)
    if (this._onFederatedMessage) {
      this._onFederatedMessage({
        id: msgId,
        channel_id: channelId,
        from_user: fromUser,
        body,
        created_at: timestamp,
        federated: true,
        source_instance: msg.from,
        origin,
      });
    }
  }

  _request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const fullUrl = new URL(urlPath, this.hubUrl);
      const isHttps = fullUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const payload = body ? JSON.stringify(body) : null;

      const options = {
        hostname: fullUrl.hostname,
        port: fullUrl.port || (isHttps ? 443 : 80),
        path: fullUrl.pathname + fullUrl.search,
        method,
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      };

      if (this._hubToken) {
        options.headers['X-Hub-Token'] = this._hubToken;
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
              reject(new Error(`Hub ${res.statusCode}: ${parsed.error || data}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Bad hub response: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (e) => reject(new Error(`Hub unreachable: ${e.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Hub timeout (15s)')); });

      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = { FederationService };
