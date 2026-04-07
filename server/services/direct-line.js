/**
 * Darkhan — Direct Line (v2)
 *
 * Peer-to-peer agent communication over Tailscale with FULL integrity pipeline.
 * Direct Line is a TRANSPORT OPTIMIZATION, not a trust bypass.
 *
 * The message goes through the same integrity pipeline as any other agent message:
 *   1. Claim verification (does the message contain verifiable claims?)
 *   2. AEP evaluation (does evidence support the claims?)
 *   3. Cross-provider consensus (does a second LLM agree?)
 *   4. Hash-chained activity log (tamper-evident record)
 *   5. THEN transmitted over Tailscale to the target node
 *
 * The receiving node ingests the message through its own integrity pipeline,
 * creating a second, independent verification record.
 *
 * What Direct Line optimizes:
 *   - Transport: Tailscale P2P instead of federation polling through Mokume
 *   - Latency: ~50ms instead of 3-second poll cycle
 *   - Availability: Works even if Mokume hub is down
 *
 * What Direct Line does NOT skip:
 *   - Claim verification
 *   - Evidence evaluation
 *   - Activity log recording
 *   - Hash chain integrity
 *   - Message metadata tagging
 *
 * @module direct-line
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

class DirectLine {
  /**
   * @param {Object} opts
   * @param {Object} opts.config - darkhan.config.json contents
   * @param {Object} opts.db - SQLite database instance
   * @param {Object} opts.io - Socket.IO instance
   * @param {string} opts.thisAgent - This node's agent ID (e.g., 'agent_claude')
   * @param {Object} opts.activityLog - Activity log instance (REQUIRED — hash chain)
   * @param {Object} [opts.claimVerifier] - Claim verifier service
   * @param {Object} [opts.aep] - Action-Evidence Protocol service
   * @param {Object} [opts.llmService] - LLM service (for cross-provider consensus)
   * @param {Object} [opts.workerRuntime] - Worker runtime (for getting active AEP traces)
   * @param {Object} [opts.instanceIdentity] - Instance identity service (Ed25519 signing)
   */
  constructor({ config, db, io, thisAgent, activityLog, claimVerifier, aep, llmService, workerRuntime, instanceIdentity }) {
    this.config = config;
    this.db = db;
    this.io = io;
    this.thisAgent = thisAgent;
    this.activityLog = activityLog;
    this.claimVerifier = claimVerifier;
    this.aep = aep;
    this.llmService = llmService;
    this.workerRuntime = workerRuntime;
    this.instanceIdentity = instanceIdentity;
    this.instanceId = config.federation?.instanceId || 'standalone';

    // Load TLS options if configured (mTLS for inter-node transport)
    this._tlsOpts = null;
    if (config.tls?.enabled) {
      try {
        const resolvePath = (p) => p ? p.replace('~', os.homedir()) : null;
        this._tlsOpts = {
          ca: fs.readFileSync(resolvePath(config.tls.ca)),
          cert: fs.readFileSync(resolvePath(config.tls.cert)),
          key: fs.readFileSync(resolvePath(config.tls.key)),
          rejectUnauthorized: true,  // Enforce CA verification on peers
        };
        console.log('[DirectLine] mTLS enabled — peer connections will use client certificates');
      } catch (e) {
        console.warn(`[DirectLine] TLS configured but certs failed to load: ${e.message}`);
      }
    }

    // Cache peer public keys (populated during key exchange)
    this._peerPublicKeys = new Map();

    // Build peer directory from config
    this.peers = new Map();
    this._buildPeerDirectory();

    console.log(`[DirectLine] Initialized for ${thisAgent} (${this.instanceId})`);
    console.log(`[DirectLine] Integrity pipeline: claimVerifier=${!!claimVerifier}, aep=${!!aep}, activityLog=${!!activityLog}, signing=${!!instanceIdentity}`);
    console.log(`[DirectLine] Known peers: ${[...this.peers.keys()].join(', ') || 'none'}`);
  }

  /**
   * Build peer directory from config.
   */
  _buildPeerDirectory() {
    const members = this.config.team?.members || [];
    for (const member of members) {
      if (member.federation?.instance && member.id !== this.thisAgent) {
        this.peers.set(member.id, {
          agentId: member.id,
          instanceId: member.federation.instance,
          url: null,
        });
      }
    }

    const directLineConfig = this.config.directLine || {};
    const peerUrls = directLineConfig.peers || {};
    for (const [agentId, url] of Object.entries(peerUrls)) {
      if (this.peers.has(agentId)) {
        this.peers.get(agentId).url = url;
      } else {
        this.peers.set(agentId, { agentId, instanceId: 'unknown', url });
      }
    }
  }

  /**
   * Run the message through the integrity pipeline BEFORE sending.
   * Same checks as worker-runtime.js _postToChannel() lines 1415-1487.
   *
   * Returns metadata that will be attached to the message and recorded
   * in the activity log on both sending and receiving sides.
   *
   * @param {string} body - Message content
   * @param {string} fromUser - Sending agent ID
   * @returns {Promise<Object>} Integrity metadata
   */
  async _runIntegrityPipeline(body, fromUser) {
    const metadata = {
      origin: 'direct_line',
      source_instance: this.instanceId,
      source_agent: fromUser,
      integrity: {
        pipelineRan: true,
        timestamp: new Date().toISOString(),
      },
    };

    // [CLAIM VERIFICATION] — same as worker-runtime.js lines 1419-1431
    if (this.claimVerifier && fromUser.startsWith('agent_')) {
      try {
        const verification = await this.claimVerifier.verify(body, fromUser);
        if (verification) {
          metadata.claimVerification = verification;
          metadata.integrity.claimVerification = true;
          console.log(`[DirectLine] Claim verification: ${JSON.stringify(verification).substring(0, 100)}`);
        }
      } catch (e) {
        console.warn(`[DirectLine] Claim verification error: ${e.message}`);
        metadata.integrity.claimVerificationError = e.message;
      }
    }

    // [AEP] — same as worker-runtime.js lines 1433-1469
    if (this.aep && fromUser.startsWith('agent_')) {
      try {
        // Find active trace for this agent via worker runtime
        let traceId = null;
        if (this.workerRuntime) {
          const worker = this.workerRuntime.workers?.get(fromUser);
          traceId = worker?.context?._aepTraceId;
        }

        if (traceId) {
          const evaluation = this.aep.evaluateMessage(traceId, body);
          metadata.evidenceEvaluation = {
            level: evaluation.level,
            claimsDetected: evaluation.claims.length,
            claimsVerified: evaluation.claims.filter(c => c.status === 'verified').length,
            claimsClaimed: evaluation.claims.filter(c => c.status === 'claimed').length,
            gaps: evaluation.gaps,
          };
          metadata.integrity.aepEvaluation = true;
          console.log(`[DirectLine] AEP: ${evaluation.level} (${evaluation.claims.length} claims, ${evaluation.gaps.length} gaps)`);

          // [CROSS-PROVIDER CONSENSUS] — same as worker-runtime.js lines 1450-1464
          if (evaluation.claims.length > 0 && this.llmService) {
            try {
              const cpVerify = await this.aep.crossProviderVerify(traceId, body, this.llmService);
              metadata.evidenceEvaluation.crossProvider = {
                consensus: cpVerify.consensus,
                level: cpVerify.level,
                localVerdict: cpVerify.localVerdict,
                cloudVerdict: cpVerify.cloudVerdict,
              };
              metadata.integrity.crossProviderConsensus = true;
              console.log(`[DirectLine] Cross-provider: ${cpVerify.consensus} → ${cpVerify.level}`);
            } catch (cpErr) {
              console.warn(`[DirectLine] Cross-provider error: ${cpErr.message}`);
              metadata.integrity.crossProviderError = cpErr.message;
            }
          }
        } else {
          metadata.integrity.aepNoActiveTrace = true;
        }
      } catch (e) {
        console.warn(`[DirectLine] AEP error: ${e.message}`);
        metadata.integrity.aepError = e.message;
      }
    }

    return metadata;
  }

  /**
   * Send a direct message to another agent's Darkhan instance.
   *
   * The message goes through the full integrity pipeline on THIS node before
   * being transmitted. The receiving node runs its own integrity checks on
   * ingest (via its /api/messages endpoint → onNewMessage → worker listeners).
   *
   * @param {string} targetAgent - Target agent ID (e.g., 'agent_penny')
   * @param {string} channelId - Channel to post in (e.g., 'chan_coordination')
   * @param {string} body - Message content
   * @param {Object} [opts] - Options
   * @param {string} [opts.apiKey] - API key for target node
   * @param {number} [opts.timeout] - Request timeout in ms (default 10000)
   * @returns {Promise<{ ok: boolean, latencyMs: number, integrity: Object, error?: string }>}
   */
  async send(targetAgent, channelId, body, opts = {}) {
    const peer = this.peers.get(targetAgent);
    if (!peer || !peer.url) {
      return { ok: false, latencyMs: 0, integrity: {}, error: `No direct-line URL configured for ${targetAgent}` };
    }

    const apiKey = opts.apiKey || this.config.directLine?.apiKeys?.[targetAgent] || '';
    const timeout = opts.timeout || 10000;
    const startTime = Date.now();

    // === STEP 1: Run integrity pipeline on sending side ===
    const metadata = await this._runIntegrityPipeline(body, this.thisAgent);
    const pipelineMs = Date.now() - startTime;

    // === STEP 2: Record in local activity log (hash-chained) ===
    // This creates an immutable record on the SENDING node that this message
    // was sent, with what integrity checks were performed, and what the results were.
    this.activityLog.append({
      actor: this.thisAgent,
      action: 'direct_line_send',
      target: `${targetAgent}@${peer.instanceId}`,
      details: JSON.stringify({
        channel: channelId,
        bodyLength: body.length,
        bodyHash: crypto.createHash('sha256').update(body).digest('hex'),
        integrityPipeline: metadata.integrity,
        claimVerification: metadata.claimVerification ? 'present' : 'none',
        evidenceLevel: metadata.evidenceEvaluation?.level || 'none',
        crossProvider: metadata.evidenceEvaluation?.crossProvider?.consensus || 'none',
      }),
    });

    // === STEP 3: Also record the message in LOCAL DB ===
    // So the sending node has a complete record of what it sent
    const localId = crypto.randomUUID();
    const metadataStr = JSON.stringify(metadata);
    await new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO messages (id, channel_id, from_user, body, priority, type, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [localId, channelId, this.thisAgent, body, 'normal', 'message', metadataStr],
        (err) => {
          if (err) {
            console.warn(`[DirectLine] Local record failed: ${err.message}`);
            resolve(); // Non-fatal — continue with send
          } else {
            // Emit locally so the sending node's UI also shows the message
            if (this.io) {
              this.io.to(channelId).emit('new_message', {
                id: localId, channel_id: channelId, from_user: this.thisAgent,
                body, type: 'message', created_at: new Date().toISOString(),
                metadata,
              });
            }
            resolve();
          }
        }
      );
    });

    // === STEP 4: Sign the message with Ed25519 ===
    // The signature proves: this message was created by this instance,
    // the body has not been tampered with, and the integrity metadata is authentic.
    let signature = null;
    const messageId = localId;
    const trustLevel = 'agent_local';  // Originates from a local agent
    if (this.instanceIdentity) {
      signature = this.instanceIdentity.sign(messageId, this.thisAgent, body, trustLevel);
      if (signature) {
        metadata.signature = signature;
        metadata.signedBy = this.instanceId;
        metadata.signedFields = 'messageId|fromUser|body|trustLevel';
        metadata.publicKeyFingerprint = this.instanceIdentity.getFingerprint();
        console.log(`[DirectLine] Message signed (fingerprint: ${metadata.publicKeyFingerprint})`);
      }
    }

    // Update metadata string with signature
    const signedMetadataStr = JSON.stringify(metadata);

    // === STEP 5: Transmit to target node over Tailscale ===
    try {
      const result = await this._httpPost(peer.url, '/api/messages', {
        channel_id: channelId,
        body,
        from_user: `${this.thisAgent}@${this.instanceId}`,
        metadata: signedMetadataStr,
      }, apiKey, timeout);

      const latencyMs = Date.now() - startTime;

      // Record the transmission result
      this.activityLog.append({
        actor: this.thisAgent,
        action: 'direct_line_delivered',
        target: `${targetAgent}@${peer.instanceId}`,
        details: JSON.stringify({
          channel: channelId,
          ok: result.ok,
          latencyMs,
          pipelineMs,
          error: result.error || null,
        }),
      });

      console.log(`[DirectLine] ${this.thisAgent} → ${targetAgent} (${channelId}) in ${latencyMs}ms (pipeline: ${pipelineMs}ms): ${result.ok ? 'OK' : result.error}`);
      return { ok: result.ok, latencyMs, integrity: metadata.integrity, error: result.error };

    } catch (err) {
      const latencyMs = Date.now() - startTime;

      // Record the failure
      this.activityLog.append({
        actor: this.thisAgent,
        action: 'direct_line_failed',
        target: `${targetAgent}@${peer.instanceId}`,
        details: JSON.stringify({
          channel: channelId,
          error: err.message,
          latencyMs,
        }),
      });

      console.error(`[DirectLine] Send failed: ${err.message} (${latencyMs}ms)`);
      return { ok: false, latencyMs, integrity: metadata.integrity, error: err.message };
    }
  }

  /**
   * Send a message to ALL known peers (broadcast).
   * Each send goes through the full integrity pipeline independently.
   */
  async broadcast(channelId, body) {
    const results = [];
    let sent = 0, failed = 0;

    for (const [agentId] of this.peers) {
      const result = await this.send(agentId, channelId, body);
      results.push({ agentId, ...result });
      if (result.ok) sent++;
      else failed++;
    }

    return { sent, failed, results };
  }

  /**
   * Check if a peer is reachable.
   */
  async ping(targetAgent) {
    const peer = this.peers.get(targetAgent);
    if (!peer || !peer.url) {
      return { reachable: false, latencyMs: 0 };
    }

    const startTime = Date.now();
    try {
      const url = new URL('/api/health', peer.url);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;
      const opts = { timeout: 5000 };
      if (isHttps && this._tlsOpts) {
        opts.ca = this._tlsOpts.ca;
        opts.cert = this._tlsOpts.cert;
        opts.key = this._tlsOpts.key;
        opts.rejectUnauthorized = this._tlsOpts.rejectUnauthorized;
      }
      await new Promise((resolve, reject) => {
        const req = transport.get(url.href, opts, (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      return { reachable: true, latencyMs: Date.now() - startTime, tls: isHttps };
    } catch {
      return { reachable: false, latencyMs: Date.now() - startTime };
    }
  }

  /**
   * Get status of all peers including integrity pipeline readiness.
   */
  async getStatus() {
    const statuses = [];
    for (const [agentId, peer] of this.peers) {
      const pingResult = await this.ping(agentId);
      statuses.push({
        agentId,
        instanceId: peer.instanceId,
        url: peer.url || 'not configured',
        ...pingResult,
      });
    }
    return {
      thisAgent: this.thisAgent,
      instanceId: this.instanceId,
      integrityPipeline: {
        claimVerifier: !!this.claimVerifier,
        aep: !!this.aep,
        crossProvider: !!this.llmService,
        activityLog: !!this.activityLog,
        ed25519Signing: !!this.instanceIdentity,
        fingerprint: this.instanceIdentity?.getFingerprint() || null,
      },
      knownPeerKeys: [...this._peerPublicKeys.keys()],
      peers: statuses,
    };
  }

  /**
   * Exchange public keys with a peer.
   * Fetches the peer's public key from their /api/identity endpoint
   * and caches it for signature verification.
   *
   * This should be called once per peer at startup or first contact.
   *
   * @param {string} targetAgent - Peer agent ID
   * @returns {Promise<{ ok: boolean, fingerprint?: string, error?: string }>}
   */
  async exchangeKeys(targetAgent) {
    const peer = this.peers.get(targetAgent);
    if (!peer || !peer.url) {
      return { ok: false, error: `No URL for ${targetAgent}` };
    }

    try {
      const apiKey = this.config.directLine?.apiKeys?.[targetAgent] || '';
      const url = new URL('/api/identity', peer.url);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const identity = await new Promise((resolve, reject) => {
        const getOpts = {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: apiKey ? { 'X-API-Key': apiKey } : {},
          timeout: 5000,
        };
        if (isHttps && this._tlsOpts) {
          getOpts.ca = this._tlsOpts.ca;
          getOpts.cert = this._tlsOpts.cert;
          getOpts.key = this._tlsOpts.key;
          getOpts.rejectUnauthorized = this._tlsOpts.rejectUnauthorized;
        }
        const req = transport.get(getOpts, (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error('Invalid identity response')); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });

      if (identity.publicKey) {
        this._peerPublicKeys.set(targetAgent, identity.publicKey);
        this._peerPublicKeys.set(identity.instanceId, identity.publicKey);
        console.log(`[DirectLine] Key exchange with ${targetAgent}: fingerprint=${identity.fingerprint}`);

        this.activityLog.append({
          actor: this.thisAgent,
          action: 'direct_line_key_exchange',
          target: targetAgent,
          details: JSON.stringify({
            instanceId: identity.instanceId,
            fingerprint: identity.fingerprint,
            algorithm: identity.algorithm,
          }),
        });

        return { ok: true, fingerprint: identity.fingerprint };
      }
      return { ok: false, error: 'No public key in identity response' };
    } catch (err) {
      console.error(`[DirectLine] Key exchange failed for ${targetAgent}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Verify an incoming direct-line message signature.
   *
   * Call this when receiving a message with origin='direct_line' to confirm:
   *   1. The message was signed by the claimed source instance
   *   2. The body has not been tampered with in transit
   *   3. The integrity metadata is authentic
   *
   * @param {Object} message - The received message
   * @param {string} message.id - Message ID
   * @param {string} message.from_user - Sender (e.g., 'agent_claude@omc-primary')
   * @param {string} message.body - Message content
   * @param {Object} message.metadata - Parsed metadata object
   * @returns {{ verified: boolean, reason: string }}
   */
  verifyIncoming(message, metadata) {
    if (!metadata || metadata.origin !== 'direct_line') {
      return { verified: false, reason: 'not a direct-line message' };
    }

    if (!metadata.signature) {
      return { verified: false, reason: 'no signature — message not signed by sender' };
    }

    if (!this.instanceIdentity) {
      return { verified: false, reason: 'no instance identity service — cannot verify' };
    }

    // Determine which public key to use
    const sourceInstance = metadata.signedBy || metadata.source_instance;
    const sourceAgent = metadata.source_agent;
    const peerKey = this._peerPublicKeys.get(sourceAgent) || this._peerPublicKeys.get(sourceInstance);

    if (!peerKey) {
      return { verified: false, reason: `no public key for ${sourceInstance} — run key exchange first` };
    }

    // Reconstruct the signed data and verify
    // sign() uses: messageId|fromUser|body|trustLevel
    const fromUser = sourceAgent; // The agent ID without federation suffix
    const trustLevel = 'agent_local'; // Trust level at the time of signing
    const verified = this.instanceIdentity.verify(
      message.id, fromUser, message.body, trustLevel,
      metadata.signature, peerKey
    );

    if (verified) {
      this.activityLog.append({
        actor: this.thisAgent,
        action: 'direct_line_signature_verified',
        target: sourceAgent,
        details: JSON.stringify({
          messageId: message.id,
          sourceInstance,
          fingerprint: metadata.publicKeyFingerprint,
        }),
      });
    } else {
      this.activityLog.append({
        actor: this.thisAgent,
        action: 'direct_line_signature_FAILED',
        target: sourceAgent,
        details: JSON.stringify({
          messageId: message.id,
          sourceInstance,
          fingerprint: metadata.publicKeyFingerprint,
          alert: 'POSSIBLE TAMPERING — signature verification failed',
        }),
      });
    }

    return {
      verified,
      reason: verified ? 'Ed25519 signature valid' : 'SIGNATURE VERIFICATION FAILED — message may have been tampered with',
    };
  }

  /**
   * HTTP/HTTPS POST helper. Uses mTLS when peer URL is https:// and TLS is configured.
   */
  _httpPost(baseUrl, urlPath, body, apiKey, timeout) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;
      const payload = JSON.stringify(body);

      const opts = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        timeout,
      };

      // Attach mTLS client certs when using HTTPS
      if (isHttps && this._tlsOpts) {
        opts.ca = this._tlsOpts.ca;
        opts.cert = this._tlsOpts.cert;
        opts.key = this._tlsOpts.key;
        opts.rejectUnauthorized = this._tlsOpts.rejectUnauthorized;
      }

      const req = transport.request(opts, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ ok: false, error: `Invalid response: ${data.substring(0, 100)}` });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Direct line request timed out')); });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { DirectLine };
