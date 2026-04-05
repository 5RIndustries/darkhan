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
  constructor({ config, db, io, activityLog }) {
    this.config = config;
    this.db = db;
    this.io = io;
    this.activityLog = activityLog;

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
  async relayMessage({ channel, fromUser, body, to }) {
    if (!this._connected) return;

    const message = {
      channel,
      fromUser,
      body,
      to: to || null,
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
    console.log(`[Federation] Connected to hub — ${result.peerCount} peer(s) in network`);
    return result;
  }

  async _heartbeat() {
    try {
      if (!this._connected) {
        // Try to reconnect
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
    } catch {
      this._connected = false;
    }
  }

  _startPolling(intervalMs) {
    this._lastPollTimestamp = new Date().toISOString();

    const poll = async () => {
      if (!this._connected) return;

      try {
        const result = await this._request('GET',
          `/api/federation/messages?instanceId=${encodeURIComponent(this.instanceId)}` +
          `&since=${encodeURIComponent(this._lastPollTimestamp)}&limit=50`
        );

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

    this._pollInterval = setInterval(poll, intervalMs);
    setTimeout(poll, 1000); // First poll after 1s
  }

  /**
   * Insert a federated message into the local Darkhan database and emit via Socket.IO.
   */
  _ingestMessage(msg) {
    const channelId = msg.channel || 'chan_command';
    const fromUser = `${msg.fromUser}@${msg.from}`;
    const body = msg.body;
    const timestamp = msg.originalTimestamp || msg.timestamp;

    // Insert into local messages table
    const sql = `INSERT INTO messages (id, channel_id, from_user, body, created_at)
                 VALUES (?, ?, ?, ?, ?)`;
    const msgId = `fed_${msg.id}`;

    this.db.run(sql, [msgId, channelId, fromUser, body, timestamp.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace('Z', '')], (err) => {
      if (err) {
        // Duplicate or other error — skip
        if (!err.message.includes('UNIQUE constraint')) {
          console.error(`[Federation] Message insert error: ${err.message}`);
        }
        return;
      }

      // Emit to connected clients via Socket.IO
      if (this.io) {
        this.io.emit('message', {
          id: msgId,
          channel_id: channelId,
          from_user: fromUser,
          body,
          created_at: timestamp,
          federated: true,
          source_instance: msg.from,
        });
      }
    });

    // Log to activity
    this.activityLog.append({
      actor: fromUser,
      action: 'federated_message',
      target: channelId,
      details: JSON.stringify({ source: msg.from, messageId: msg.id }),
    });
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
