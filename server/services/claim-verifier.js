/**
 * Darkhan — Claim Verifier Service
 *
 * Scans agent messages for verifiable claims and tags them with evidence.
 * Runs AFTER security scanning but BEFORE database INSERT.
 * Only processes agent messages (from_user starts with "agent_").
 *
 * Design principles:
 * - Deterministic: pattern matching only, no LLM calls
 * - Fast: target <100ms per message (file stat calls are cheap)
 * - Non-blocking: never modifies message body, only adds metadata
 * - Honest: tags self-reported claims as unverified, not false
 */

const fs = require('fs');
const path = require('path');

class ClaimVerifierService {
  constructor({ vaultPath, db, activityLog, groundTruth = null }) {
    this.vaultPath = vaultPath;
    this.db = db;
    this.activityLog = activityLog;
    this.groundTruth = groundTruth; // Set after GroundTruthRegistry initializes

    // File reference patterns — capture the path portion
    this.filePatterns = [
      // "saved to DRAFT/filename.md" or "saved to project/output/filename.md"
      { regex: /saved\s+to\s+([A-Za-z0-9_\-/.]+\.(?:md|txt|json|csv|pdf|py|js|yaml|yml))/gi, type: 'file_exists' },
      // "output at project/output/filename.md"
      { regex: /output\s+(?:at|to|in)\s+([A-Za-z0-9_\-/.]+\.(?:md|txt|json|csv|pdf|py|js|yaml|yml))/gi, type: 'file_exists' },
      // "wrote to project/output/filename.md" or "written to ..."
      { regex: /writ(?:ten|e|ing)\s+to\s+([A-Za-z0-9_\-/.]+\.(?:md|txt|json|csv|pdf|py|js|yaml|yml))/gi, type: 'file_exists' },
      // "created project/output/filename.md" or "created file ..."
      { regex: /created\s+(?:file\s+)?([A-Za-z0-9_\-/.]+\.(?:md|txt|json|csv|pdf|py|js|yaml|yml))/gi, type: 'file_exists' },
      // Explicit path references: "DRAFT/2026-03-28_something.md" or "project/output/something.md"
      { regex: /(?:DRAFT|Intel|Sprints|Decisions|Pipeline|CoS|Lindsey\/Results)\/[A-Za-z0-9_\-]+\.(?:md|txt|json)/g, type: 'file_exists' },
    ];

    // Completion claim patterns — "completed X", "done with X", "finished X"
    this.completionPatterns = [
      /(?:completed|finished|done\s+with|executed)\s+(?:the\s+)?(?:task\s+)?["']?([^"'\n,.]+)["']?/gi,
    ];

    // Status claim patterns — "X is operational/running/online"
    this.statusPatterns = [
      /(\w+)\s+(?:is\s+)?(?:operational|running|online|active|healthy)/gi,
      /(?:operational|running|online|active|healthy):\s*(\w+)/gi,
    ];

    // Count/quantity patterns — self-reported numbers
    this.countPatterns = [
      /(?:found|processed|scanned|analyzed|reviewed|checked|identified)\s+(\d+)\s+/gi,
      /(\d+)\s+(?:items?|messages?|files?|documents?|issues?|errors?|results?)\s+(?:found|processed|scanned|analyzed|reviewed)/gi,
    ];

    console.log('[ClaimVerifier] Service initialized');
  }

  /**
   * Verify claims in an agent message.
   * Returns a claimVerification metadata object, or null if no claims found.
   *
   * Target: <100ms execution time.
   */
  async verify(messageBody, fromUser) {
    const startTime = Date.now();
    const claims = [];

    // 1. Check file reference claims
    this._extractFileClaims(messageBody, claims);

    // 2. Check status claims against heartbeat table
    await this._extractStatusClaims(messageBody, claims);

    // 3. Tag count/quantity claims as self-reported
    this._extractCountClaims(messageBody, claims);

    // 4. Check against ground truth registry
    let groundTruthResults = [];
    if (this.groundTruth) {
      groundTruthResults = this.groundTruth.checkMessage(messageBody);
      for (const gt of groundTruthResults) {
        claims.push({
          claim: gt.key,
          type: 'ground_truth',
          verified: gt.contradiction ? false : true,
          evidence: gt.evidence,
          contradiction: gt.contradiction || null,
        });
      }
    }

    // No claims found — nothing to tag
    if (claims.length === 0) return null;

    // Verify file claims (bulk — all at once)
    await this._verifyFileClaims(claims);

    const elapsed = Date.now() - startTime;

    // Tally results
    const verified = claims.filter(c => c.verified === true).length;
    const unverified = claims.filter(c => c.verified === false).length;
    const selfReported = claims.filter(c => c.verified === 'self-reported').length;
    const deferred = claims.filter(c => c.verified === 'deferred').length;

    const result = {
      claims,
      verifiedAt: new Date().toISOString(),
      elapsedMs: elapsed,
      summary: this._buildSummary(verified, unverified, selfReported, deferred),
    };

    // Log verification activity
    this.activityLog.append({
      actor: 'claim_verifier',
      action: 'claims_verified',
      target: fromUser,
      details: JSON.stringify({
        claimCount: claims.length,
        verified,
        unverified,
        selfReported,
        deferred,
        elapsedMs: elapsed,
      }),
    });

    // Warn if we're over budget
    if (elapsed > 100) {
      console.warn(`[ClaimVerifier] Verification took ${elapsed}ms (over 100ms budget) for ${fromUser}`);
    }

    return result;
  }

  /**
   * Extract file reference claims from the message body.
   */
  _extractFileClaims(body, claims) {
    const seenPaths = new Set();

    for (const { regex, type } of this.filePatterns) {
      // Reset regex state for each message
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(body)) !== null) {
        const filePath = match[type === 'file_exists' && match[1] ? 1 : 0];
        if (!filePath || seenPaths.has(filePath)) continue;
        seenPaths.add(filePath);

        claims.push({
          claim: filePath,
          type: 'file_exists',
          verified: null, // Will be resolved in _verifyFileClaims
          evidence: null,
        });
      }
    }
  }

  /**
   * Extract status claims and verify against heartbeat table.
   */
  async _extractStatusClaims(body, claims) {
    const seenAgents = new Set();

    for (const pattern of this.statusPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(body)) !== null) {
        const agentName = match[1]?.toLowerCase();
        if (!agentName || seenAgents.has(agentName)) continue;

        // Only check plausible agent names (skip generic words)
        const skipWords = new Set([
          'system', 'server', 'service', 'all', 'everything', 'it', 'this',
          'that', 'we', 'i', 'the', 'is', 'are', 'was', 'were',
        ]);
        if (skipWords.has(agentName)) continue;
        seenAgents.add(agentName);

        // Check heartbeat table
        const heartbeat = await this._getHeartbeat(agentName);
        if (heartbeat) {
          const lastPing = new Date(heartbeat.last_ping_at);
          const ageMinutes = (Date.now() - lastPing.getTime()) / 60000;
          const isRecent = ageMinutes < 10; // Consider "active" if pinged within 10 minutes

          claims.push({
            claim: `${agentName} is operational`,
            type: 'heartbeat_check',
            verified: heartbeat.status === 'active' && isRecent,
            evidence: `status: ${heartbeat.status}, last ping: ${heartbeat.last_ping_at} (${Math.round(ageMinutes)}m ago)`,
          });
        } else {
          // No heartbeat record — can't verify, mark as unverifiable
          claims.push({
            claim: `${agentName} is operational`,
            type: 'heartbeat_check',
            verified: false,
            evidence: 'no heartbeat record found',
          });
        }
      }
    }
  }

  /**
   * Extract count/quantity claims and tag as self-reported.
   */
  _extractCountClaims(body, claims) {
    const seenClaims = new Set();

    for (const pattern of this.countPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(body)) !== null) {
        const fullMatch = match[0].trim();
        if (seenClaims.has(fullMatch)) continue;
        seenClaims.add(fullMatch);

        claims.push({
          claim: fullMatch,
          type: 'count_claim',
          verified: 'self-reported',
          evidence: 'numeric claim — not independently verified',
        });
      }
    }
  }

  /**
   * Verify all file_exists claims by checking the filesystem.
   * Resolves relative paths against the vault root.
   */
  async _verifyFileClaims(claims) {
    for (const claim of claims) {
      if (claim.type !== 'file_exists') continue;

      try {
        const resolvedPath = this._resolveFilePath(claim.claim);
        if (!resolvedPath) {
          claim.verified = 'deferred';
          claim.evidence = 'could not resolve path';
          continue;
        }

        const exists = fs.existsSync(resolvedPath);
        if (exists) {
          const stat = fs.statSync(resolvedPath);
          const modifiedAt = stat.mtime.toISOString();
          const ageMinutes = (Date.now() - stat.mtime.getTime()) / 60000;

          claim.verified = true;
          claim.evidence = `file exists, ${stat.size} bytes, modified ${modifiedAt}${ageMinutes < 30 ? ' (recent)' : ''}`;
        } else {
          claim.verified = false;
          claim.evidence = 'file not found';
        }
      } catch (err) {
        claim.verified = 'deferred';
        claim.evidence = `check failed: ${err.message}`;
      }
    }
  }

  /**
   * Resolve a file path reference to an absolute path.
   * Handles common vault-relative patterns:
   *   - "DRAFT/filename.md" → vaultPath/project/drafts/filename.md
   *   - "Intel/filename.md" → vaultPath/project/output/filename.md
   *   - "project/output/filename.md" → vaultPath/project/output/filename.md
   *   - Absolute paths pass through
   */
  _resolveFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return null;

    // Absolute paths pass through
    if (filePath.startsWith('/')) return filePath;

    // Home directory expansion
    if (filePath.startsWith('~/')) {
      return filePath.replace('~', process.env.HOME);
    }

    // Common vault-relative prefixes
    const prefixMap = {
      'DRAFT/': 'project/drafts/',
      'Intel/': 'project/output/',
      'Sprints/': 'project/sprints/',
      'Decisions/': 'project/decisions/',
      'Pipeline/': 'project/pipeline/',
      'CoS/': 'project/cos/',
    };

    for (const [prefix, expanded] of Object.entries(prefixMap)) {
      if (filePath.startsWith(prefix)) {
        return path.join(this.vaultPath, expanded, filePath.substring(prefix.length));
      }
    }

    // Already has OMC-OS prefix or other vault-relative path
    return path.join(this.vaultPath, filePath);
  }

  /**
   * Query the heartbeat table for an agent.
   */
  _getHeartbeat(agentName) {
    return new Promise((resolve) => {
      // Try exact match first, then with agent_ prefix
      const candidates = [agentName, `agent_${agentName}`];
      let found = false;

      const tryNext = (idx) => {
        if (idx >= candidates.length) return resolve(null);
        this.db.get(
          'SELECT agent, status, last_ping_at FROM agent_heartbeats WHERE LOWER(agent) = ?',
          [candidates[idx].toLowerCase()],
          (err, row) => {
            if (err || !row) return tryNext(idx + 1);
            found = true;
            resolve(row);
          }
        );
      };

      tryNext(0);
    });
  }

  /**
   * Build a human-readable summary string.
   */
  _buildSummary(verified, unverified, selfReported, deferred) {
    const parts = [];
    if (verified > 0) parts.push(`${verified} verified`);
    if (unverified > 0) parts.push(`${unverified} unverified`);
    if (selfReported > 0) parts.push(`${selfReported} self-reported`);
    if (deferred > 0) parts.push(`${deferred} deferred`);
    return parts.join(', ');
  }
}

module.exports = { ClaimVerifierService };
