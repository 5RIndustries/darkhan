/**
 * Darkhan — Action-Evidence Protocol (AEP)
 *
 * Formalized system ensuring AI agents cannot misrepresent what they did.
 * Every agent action maps to a defined verb with required evidence.
 * If the evidence doesn't match the verb, the system automatically downgrades
 * the claim.
 *
 * This is the core trust layer. The agent does NOT provide evidence — the
 * SYSTEM captures it from tool execution. Agents can claim whatever they want,
 * but the evidence trail is immutable and system-controlled.
 *
 * Integration point: worker-runtime.js calls recordEvidence() after each tool
 * execution, and evaluateMessage() before message insertion.
 *
 * Relationship to existing services:
 *   - EvidenceService: runs individual checks with hashing (low-level)
 *   - ClaimVerifierService: post-hoc message scanning (reactive)
 *   - ActionEvidenceProtocol: trace-based evidence binding (proactive, this service)
 *
 * Evidence chain:
 *   1. Worker starts a task → startTrace()
 *   2. Each tool call → recordEvidence() captures verb + evidence automatically
 *   3. Agent produces final message → evaluateMessage() compares claims to trail
 *   4. Message gets evidence_level metadata before DB insert
 */

const crypto = require('crypto');
const fs = require('fs');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Action Vocabulary — the finite set of verbs an agent can perform
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} VerbDefinition
 * @property {string} verb - The action verb identifier
 * @property {string} description - Unambiguous definition of what this verb means
 * @property {string[]} required - Required evidence fields
 * @property {Function} [verification] - Optional async verification function
 */

const ACTION_VOCABULARY = {
  WROTE_CODE: {
    verb: 'WROTE_CODE',
    description: 'Code exists in a file (not necessarily committed or deployed)',
    required: ['filePath', 'contentHash'],
    verification: async (evidence) => {
      const checks = [];
      try {
        const exists = fs.existsSync(evidence.filePath);
        checks.push({ check: 'file_exists', pass: exists });
        if (exists) {
          const content = fs.readFileSync(evidence.filePath);
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          const hashMatch = hash === evidence.contentHash;
          checks.push({ check: 'content_hash_match', pass: hashMatch, expected: evidence.contentHash, actual: hash });
        }
      } catch (err) {
        checks.push({ check: 'file_access', pass: false, error: err.message });
      }
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  COMMITTED: {
    verb: 'COMMITTED',
    description: 'Code is committed to git (evidence: git SHA)',
    required: ['gitSha', 'repository'],
    verification: async (evidence) => {
      const checks = [];
      try {
        const result = execSync(
          `git -C "${evidence.repository}" cat-file -t "${evidence.gitSha}" 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        checks.push({ check: 'sha_exists', pass: result === 'commit' });
      } catch (err) {
        checks.push({ check: 'sha_exists', pass: false, error: err.message });
      }
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  DEPLOYED: {
    verb: 'DEPLOYED',
    description: 'Process is running on the target system (not just written or committed)',
    required: ['target', 'pid', 'port', 'timestamp'],
    verification: async (evidence) => {
      const checks = [];
      // Check if PID is still running
      try {
        process.kill(Number(evidence.pid), 0); // signal 0 = existence check
        checks.push({ check: 'pid_alive', pass: true, pid: evidence.pid });
      } catch (err) {
        checks.push({ check: 'pid_alive', pass: false, pid: evidence.pid, error: err.message });
      }
      // Check if port is responding
      if (evidence.port) {
        try {
          const net = require('net');
          const portOpen = await new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(3000);
            socket.on('connect', () => { socket.destroy(); resolve(true); });
            socket.on('error', () => resolve(false));
            socket.on('timeout', () => { socket.destroy(); resolve(false); });
            socket.connect(Number(evidence.port), evidence.target || '127.0.0.1');
          });
          checks.push({ check: 'port_responding', pass: portOpen, port: evidence.port });
        } catch (err) {
          checks.push({ check: 'port_responding', pass: false, error: err.message });
        }
      }
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  VERIFIED: {
    verb: 'VERIFIED',
    description: 'Deployed AND tested — system confirmed working via test execution',
    required: ['testOutput', 'passFail', 'deployEvidence'],
    verification: async (evidence) => {
      const checks = [];
      checks.push({ check: 'test_result_present', pass: !!evidence.testOutput });
      checks.push({ check: 'pass_fail_declared', pass: typeof evidence.passFail === 'boolean' });
      checks.push({ check: 'deploy_evidence_linked', pass: !!evidence.deployEvidence });
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  SEARCHED: {
    verb: 'SEARCHED',
    description: 'Web or file search was executed (not just claimed)',
    required: ['query', 'resultCount', 'resultsHash'],
    verification: async (evidence) => {
      const checks = [];
      checks.push({ check: 'query_present', pass: typeof evidence.query === 'string' && evidence.query.length > 0 });
      checks.push({ check: 'result_count_present', pass: typeof evidence.resultCount === 'number' });
      checks.push({ check: 'results_hash_present', pass: typeof evidence.resultsHash === 'string' && evidence.resultsHash.length > 0 });
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  FETCHED: {
    verb: 'FETCHED',
    description: 'URL was retrieved — HTTP request actually executed',
    required: ['url', 'responseStatus', 'contentHash'],
    verification: async (evidence) => {
      const checks = [];
      checks.push({ check: 'url_present', pass: typeof evidence.url === 'string' && evidence.url.startsWith('http') });
      checks.push({ check: 'status_code_present', pass: typeof evidence.responseStatus === 'number' });
      checks.push({ check: 'content_hash_present', pass: typeof evidence.contentHash === 'string' && evidence.contentHash.length > 0 });
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  ANALYZED: {
    verb: 'ANALYZED',
    description: 'Conclusions drawn from data — requires source data reference and reasoning chain',
    required: ['sourceRef', 'reasoning'],
    verification: async (evidence) => {
      const checks = [];
      checks.push({ check: 'source_reference', pass: !!evidence.sourceRef });
      checks.push({ check: 'reasoning_present', pass: typeof evidence.reasoning === 'string' && evidence.reasoning.length > 0 });
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  READ_FILE: {
    verb: 'READ_FILE',
    description: 'File was read from the filesystem',
    required: ['filePath', 'fileSize', 'contentHash'],
    verification: async (evidence) => {
      const checks = [];
      try {
        const exists = fs.existsSync(evidence.filePath);
        checks.push({ check: 'file_exists', pass: exists });
        if (exists) {
          const stat = fs.statSync(evidence.filePath);
          checks.push({ check: 'size_plausible', pass: true, recorded: evidence.fileSize, current: stat.size });
        }
      } catch (err) {
        checks.push({ check: 'file_access', pass: false, error: err.message });
      }
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  WROTE_FILE: {
    verb: 'WROTE_FILE',
    description: 'File was written to the filesystem',
    required: ['filePath', 'contentHash'],
    optional: ['beforeHash'],
    verification: async (evidence) => {
      const checks = [];
      try {
        const exists = fs.existsSync(evidence.filePath);
        checks.push({ check: 'file_exists', pass: exists });
        if (exists) {
          const content = fs.readFileSync(evidence.filePath);
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          checks.push({ check: 'content_hash_current', pass: hash === evidence.contentHash, expected: evidence.contentHash, actual: hash });
        }
      } catch (err) {
        checks.push({ check: 'file_access', pass: false, error: err.message });
      }
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  SHELL_EXEC: {
    verb: 'SHELL_EXEC',
    description: 'Shell command was executed',
    required: ['command', 'exitCode', 'stdoutHash'],
    verification: async (evidence) => {
      const checks = [];
      checks.push({ check: 'command_present', pass: typeof evidence.command === 'string' && evidence.command.length > 0 });
      checks.push({ check: 'exit_code_present', pass: typeof evidence.exitCode === 'number' });
      checks.push({ check: 'stdout_hash_present', pass: typeof evidence.stdoutHash === 'string' });
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  SENT_MESSAGE: {
    verb: 'SENT_MESSAGE',
    description: 'Message was posted to a channel',
    required: ['messageId', 'channel'],
    verification: async (evidence) => {
      const checks = [];
      checks.push({ check: 'message_id_present', pass: !!evidence.messageId });
      checks.push({ check: 'channel_present', pass: typeof evidence.channel === 'string' && evidence.channel.length > 0 });
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  CLAIMED: {
    verb: 'CLAIMED',
    description: 'Statement made without tool execution backing it — the honesty flag',
    required: [], // No evidence required — that is the point
    verification: async () => ({ valid: true, checks: [{ check: 'no_evidence_expected', pass: true }] }),
  },

  FAILED: {
    verb: 'FAILED',
    description: 'Action was attempted but did not succeed',
    required: ['attemptedAction', 'errorMessage'],
    verification: async (evidence) => {
      const checks = [];
      checks.push({ check: 'attempted_action_present', pass: typeof evidence.attemptedAction === 'string' });
      checks.push({ check: 'error_present', pass: typeof evidence.errorMessage === 'string' && evidence.errorMessage.length > 0 });
      return { valid: checks.every(c => c.pass), checks };
    },
  },

  PRIVILEGE_BOUNDARY: {
    verb: 'PRIVILEGE_BOUNDARY',
    description: 'Agent accessed a resource outside its authorized scope — capability exceeded authorization',
    required: ['resource', 'authorizedScope', 'action'],
    verification: async (evidence) => {
      const checks = [];
      checks.push({ check: 'resource_identified', pass: typeof evidence.resource === 'string' });
      checks.push({ check: 'scope_documented', pass: typeof evidence.authorizedScope === 'string' });
      checks.push({ check: 'action_described', pass: typeof evidence.action === 'string' });
      return { valid: checks.every(c => c.pass), checks };
    },
  },
};

// ---------------------------------------------------------------------------
// Claim detection patterns — used by evaluateMessage to find agent claims
// ---------------------------------------------------------------------------

/**
 * Maps natural-language claim phrases to expected verbs.
 * Each pattern has a regex and the verb it implies.
 */
const CLAIM_PATTERNS = [
  // DEPLOYED
  { regex: /\b(?:i\s+)?deploy(?:ed|ing)?\b/gi, verb: 'DEPLOYED' },
  { regex: /\blaunched?\b.*\b(?:server|service|process|worker)\b/gi, verb: 'DEPLOYED' },
  { regex: /\bprocess\s+(?:is\s+)?running\b/gi, verb: 'DEPLOYED' },
  { regex: /\b(?:server|service)\s+is\s+(?:up|live|running|operational)\b/gi, verb: 'DEPLOYED' },

  // VERIFIED
  { regex: /\b(?:i\s+)?verif(?:ied|y|ying)\b/gi, verb: 'VERIFIED' },
  { regex: /\btested?\s+and\s+(?:confirmed|passed|working)\b/gi, verb: 'VERIFIED' },
  { regex: /\bconfirm(?:ed)?\s+(?:it\s+)?(?:works?|working|operational)\b/gi, verb: 'VERIFIED' },

  // COMMITTED
  { regex: /\b(?:i\s+)?commit(?:ted|ting)?\b/gi, verb: 'COMMITTED' },
  { regex: /\bpush(?:ed)?\s+to\s+(?:git|repo|remote|origin|main|master)\b/gi, verb: 'COMMITTED' },

  // WROTE_CODE / WROTE_FILE
  { regex: /\b(?:i\s+)?(?:wrote|written|created|built)\s+(?:the\s+)?(?:code|script|module|service|function)\b/gi, verb: 'WROTE_CODE' },
  { regex: /\b(?:i\s+)?(?:wrote|written|created|saved)\s+(?:the\s+)?(?:file|document|config|report)\b/gi, verb: 'WROTE_FILE' },

  // SEARCHED
  { regex: /\b(?:i\s+)?search(?:ed|ing)?\s+(?:for|the|web|files?)\b/gi, verb: 'SEARCHED' },
  { regex: /\b(?:i\s+)?(?:looked|looking)\s+up\b/gi, verb: 'SEARCHED' },
  { regex: /\b(?:i\s+)?(?:queried|ran\s+a\s+query)\b/gi, verb: 'SEARCHED' },

  // FETCHED
  { regex: /\b(?:i\s+)?fetch(?:ed|ing)?\b/gi, verb: 'FETCHED' },
  { regex: /\b(?:i\s+)?(?:retrieved|downloaded|pulled)\s+(?:from|the)\b/gi, verb: 'FETCHED' },
  { regex: /\b(?:i\s+)?(?:called|hit|requested)\s+(?:the\s+)?(?:API|endpoint|URL)\b/gi, verb: 'FETCHED' },

  // ANALYZED
  { regex: /\b(?:i\s+)?analyz(?:ed|ing|e)\b/gi, verb: 'ANALYZED' },
  { regex: /\b(?:i\s+)?(?:reviewed|examined|inspected|evaluated|assessed)\b/gi, verb: 'ANALYZED' },

  // READ_FILE
  { regex: /\b(?:i\s+)?read\s+(?:the\s+)?(?:file|config|log|document)\b/gi, verb: 'READ_FILE' },
  { regex: /\b(?:i\s+)?(?:checked|inspected)\s+(?:the\s+)?(?:file|config|log)\b/gi, verb: 'READ_FILE' },

  // SHELL_EXEC
  { regex: /\b(?:i\s+)?(?:ran|executed|run)\s+(?:the\s+)?(?:command|script|shell)\b/gi, verb: 'SHELL_EXEC' },

  // SENT_MESSAGE
  { regex: /\b(?:i\s+)?(?:sent|posted|messaged)\b/gi, verb: 'SENT_MESSAGE' },

  // FAILED
  { regex: /\b(?:failed|errored|crashed|couldn'?t|unable)\b/gi, verb: 'FAILED' },
];


// ---------------------------------------------------------------------------
// ActionEvidenceProtocol — the main service class
// ---------------------------------------------------------------------------

class ActionEvidenceProtocol {
  /**
   * @param {Object} opts
   * @param {Object} opts.activityLog - Immutable activity log instance (required)
   * @param {Object} opts.db - SQLite database instance (required)
   */
  constructor({ activityLog, db }) {
    if (!activityLog) throw new Error('ActionEvidenceProtocol requires activityLog');
    if (!db) throw new Error('ActionEvidenceProtocol requires db');

    this.activityLog = activityLog;
    this.db = db;

    /** @type {Map<string, Trace>} Active traces keyed by traceId */
    this.traces = new Map();

    /** @type {number} Max trace age in ms before auto-cleanup (1 hour) */
    this.maxTraceAge = 60 * 60 * 1000;

    this._ensureTable();
    this._startCleanupInterval();

    console.log('[AEP] Action-Evidence Protocol initialized');
  }

  // -------------------------------------------------------------------------
  // Database setup
  // -------------------------------------------------------------------------

  /**
   * Ensure the evidence_traces table exists for persistent storage.
   */
  _ensureTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS evidence_traces (
        trace_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        evidence_trail TEXT NOT NULL DEFAULT '[]',
        evaluation TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_evidence_traces_agent
        ON evidence_traces(agent_id)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_evidence_traces_status
        ON evidence_traces(status)
    `);
  }

  // -------------------------------------------------------------------------
  // Trace lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start tracking a task execution. Returns a unique trace ID.
   *
   * @param {string} agentId - The agent performing the task
   * @param {string} taskName - Human-readable name of the task
   * @returns {string} traceId - Unique identifier for this execution trace
   */
  startTrace(agentId, taskName) {
    if (!agentId || !taskName) {
      throw new Error('startTrace requires agentId and taskName');
    }

    const traceId = `aep_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const startedAt = new Date().toISOString();

    const trace = {
      traceId,
      agentId,
      taskName,
      startedAt,
      trail: [],       // Ordered list of { verb, evidence, timestamp, hash }
      status: 'active',
    };

    this.traces.set(traceId, trace);

    // Persist to DB
    this.db.run(
      `INSERT INTO evidence_traces (trace_id, agent_id, task_name, started_at, evidence_trail, status)
       VALUES (?, ?, ?, ?, '[]', 'active')`,
      [traceId, agentId, taskName, startedAt]
    );

    // Log to activity log
    this.activityLog.append({
      actor: 'aep',
      action: 'trace_started',
      target: agentId,
      details: JSON.stringify({ traceId, taskName }),
    });

    return traceId;
  }

  /**
   * Record evidence from a tool execution. Called by worker-runtime after
   * each tool call — the agent does NOT call this directly.
   *
   * @param {string} traceId - The active trace to record against
   * @param {string} verb - One of the ACTION_VOCABULARY keys
   * @param {Object} evidence - Evidence fields matching the verb's required schema
   * @throws {Error} If traceId is invalid or verb is not in the vocabulary
   */
  recordEvidence(traceId, verb, evidence) {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Unknown traceId: ${traceId}`);
    }
    if (trace.status !== 'active') {
      throw new Error(`Trace ${traceId} is ${trace.status}, cannot record`);
    }

    const verbDef = ACTION_VOCABULARY[verb];
    if (!verbDef) {
      throw new Error(`Unknown verb: ${verb}. Valid verbs: ${Object.keys(ACTION_VOCABULARY).join(', ')}`);
    }

    // Validate required evidence fields
    const missing = verbDef.required.filter(field => !(field in evidence));
    if (missing.length > 0) {
      // Don't throw — record with a warning. Incomplete evidence is still evidence.
      evidence._missingFields = missing;
      evidence._complete = false;
    } else {
      evidence._complete = true;
    }

    const timestamp = new Date().toISOString();

    // Build tamper-evident hash
    const hashInput = `${traceId}|${verb}|${JSON.stringify(evidence)}|${timestamp}`;
    const hash = crypto.createHash('sha256').update(hashInput).digest('hex');

    const entry = {
      verb,
      evidence,
      timestamp,
      hash,
    };

    trace.trail.push(entry);

    // Update DB
    this.db.run(
      `UPDATE evidence_traces SET evidence_trail = ? WHERE trace_id = ?`,
      [JSON.stringify(trace.trail), traceId]
    );

    // Log to activity log
    this.activityLog.append({
      actor: 'aep',
      action: 'evidence_recorded',
      target: trace.agentId,
      details: JSON.stringify({
        traceId,
        verb,
        complete: evidence._complete,
        hash,
      }),
    });
  }

  /**
   * Get the full evidence trail for a trace.
   *
   * @param {string} traceId - The trace to retrieve
   * @returns {Array<{verb: string, evidence: Object, timestamp: string, hash: string}>}
   */
  getTrace(traceId) {
    const trace = this.traces.get(traceId);
    if (trace) {
      return trace.trail.map(entry => ({
        verb: entry.verb,
        evidence: entry.evidence,
        timestamp: entry.timestamp,
        hash: entry.hash,
      }));
    }

    // Fall back to DB for completed/expired traces
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT evidence_trail FROM evidence_traces WHERE trace_id = ?',
        [traceId],
        (err, row) => {
          if (err) return reject(err);
          if (!row) return resolve([]);
          try {
            resolve(JSON.parse(row.evidence_trail));
          } catch (e) {
            resolve([]);
          }
        }
      );
    });
  }

  /**
   * Evaluate an agent's message against its evidence trail. This is the core
   * trust gate — it detects when an agent claims more than the evidence supports.
   *
   * @param {string} traceId - The trace to evaluate against
   * @param {string} messageBody - The agent's message text
   * @returns {Object} Evaluation result:
   *   - level: 'verified' | 'partial' | 'claimed' | 'contradicted'
   *   - claims: Array of detected claims with their status
   *   - gaps: Array of claims without matching evidence
   *   - trailSummary: Compact summary of the evidence trail
   */
  evaluateMessage(traceId, messageBody) {
    const trace = this.traces.get(traceId);
    if (!trace) {
      // No trace = everything is a claim
      const detected = this._detectClaims(messageBody);
      return {
        level: detected.length > 0 ? 'claimed' : 'verified',
        claims: detected.map(c => ({ ...c, status: 'unverified', evidence: null })),
        gaps: detected,
        trailSummary: [],
      };
    }

    // Build a set of verbs present in the trail
    const trailVerbs = new Set(trace.trail.map(e => e.verb));
    const trailByVerb = {};
    for (const entry of trace.trail) {
      if (!trailByVerb[entry.verb]) trailByVerb[entry.verb] = [];
      trailByVerb[entry.verb].push(entry);
    }

    // Detect claims in the message
    const detected = this._detectClaims(messageBody);

    // Evaluate each claim against the trail
    const evaluatedClaims = [];
    const gaps = [];

    for (const claim of detected) {
      const hasEvidence = trailVerbs.has(claim.verb);

      if (hasEvidence) {
        const entries = trailByVerb[claim.verb];
        const allComplete = entries.every(e => e.evidence._complete !== false);

        evaluatedClaims.push({
          ...claim,
          status: allComplete ? 'verified' : 'partial',
          evidenceCount: entries.length,
          evidenceComplete: allComplete,
        });
      } else {
        // Check for downgrade: agent claims DEPLOYED but only has WROTE_CODE
        const downgrade = this._findDowngrade(claim.verb, trailVerbs);

        evaluatedClaims.push({
          ...claim,
          status: 'unverified',
          downgraded: downgrade ? true : false,
          actualLevel: downgrade || 'CLAIMED',
          evidence: null,
        });

        gaps.push({
          ...claim,
          suggestedLevel: downgrade || 'CLAIMED',
        });
      }
    }

    // Check for contradictions: agent says success but trail has FAILED for same verb
    const failedVerbs = new Set(
      trace.trail
        .filter(e => e.verb === 'FAILED')
        .map(e => e.evidence.attemptedAction)
        .filter(Boolean)
    );

    let hasContradiction = false;
    for (const claim of evaluatedClaims) {
      if (claim.status === 'verified' && failedVerbs.has(claim.verb)) {
        claim.status = 'contradicted';
        claim.contradictionNote = `Agent claims ${claim.verb} but FAILED evidence exists for this action`;
        hasContradiction = true;
      }
    }

    // Determine overall level
    let level;
    if (hasContradiction) {
      level = 'contradicted';
    } else if (detected.length === 0) {
      level = 'verified'; // No claims made = nothing to dispute
    } else if (gaps.length === 0 && evaluatedClaims.every(c => c.status === 'verified')) {
      level = 'verified';
    } else if (gaps.length === detected.length) {
      level = 'claimed';
    } else {
      level = 'partial';
    }

    // Build trail summary
    const trailSummary = trace.trail.map(e => ({
      verb: e.verb,
      timestamp: e.timestamp,
      complete: e.evidence._complete !== false,
    }));

    // Persist evaluation
    const evaluation = { level, claims: evaluatedClaims, gaps, trailSummary };
    trace.status = 'evaluated';

    this.db.run(
      `UPDATE evidence_traces SET evaluation = ?, status = 'evaluated', completed_at = ? WHERE trace_id = ?`,
      [JSON.stringify(evaluation), new Date().toISOString(), traceId]
    );

    // Log to activity log
    this.activityLog.append({
      actor: 'aep',
      action: 'message_evaluated',
      target: trace.agentId,
      details: JSON.stringify({
        traceId,
        level,
        totalClaims: detected.length,
        verified: evaluatedClaims.filter(c => c.status === 'verified').length,
        gaps: gaps.length,
        contradictions: evaluatedClaims.filter(c => c.status === 'contradicted').length,
      }),
    });

    return evaluation;
  }

  /**
   * Get the action vocabulary with definitions and required evidence fields.
   * Useful for API/UI display and for agents to understand what evidence
   * is expected for each verb.
   *
   * @returns {{ verbs: Array<{ verb: string, description: string, required: string[] }> }}
   */
  getVocabulary() {
    return {
      verbs: Object.values(ACTION_VOCABULARY).map(v => ({
        verb: v.verb,
        description: v.description,
        required: v.required,
        optional: v.optional || [],
      })),
    };
  }

  /**
   * Run verification functions on a trace's evidence to re-check validity.
   * This is for periodic audits — re-verifies that files still exist,
   * PIDs are still running, etc.
   *
   * @param {string} traceId - The trace to re-verify
   * @returns {Array<{ verb: string, timestamp: string, verification: Object }>}
   */
  async verifyTrace(traceId) {
    const trail = await this.getTrace(traceId);
    if (!trail || trail.length === 0) return [];

    const results = [];

    for (const entry of trail) {
      const verbDef = ACTION_VOCABULARY[entry.verb];
      if (!verbDef || !verbDef.verification) continue;

      try {
        const verification = await verbDef.verification(entry.evidence);
        results.push({
          verb: entry.verb,
          timestamp: entry.timestamp,
          verification,
        });
      } catch (err) {
        results.push({
          verb: entry.verb,
          timestamp: entry.timestamp,
          verification: { valid: false, checks: [{ check: 'verification_error', pass: false, error: err.message }] },
        });
      }
    }

    return results;
  }

  /**
   * Generate a content hash for evidence capture. Utility for worker-runtime
   * to hash tool outputs before passing to recordEvidence.
   *
   * @param {string|Buffer} content - Content to hash
   * @returns {string} SHA-256 hex digest
   */
  static contentHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Build evidence objects from common tool execution results.
   * Convenience methods so worker-runtime doesn't have to construct
   * evidence objects manually.
   */
  static buildEvidence = {
    /**
     * Build WROTE_CODE / WROTE_FILE evidence from a file write result.
     * @param {string} filePath
     * @param {string|Buffer} content
     * @param {string} [beforeHash] - Hash of file before write (if applicable)
     * @returns {Object}
     */
    fileWrite(filePath, content, beforeHash = null) {
      const hash = ActionEvidenceProtocol.contentHash(
        typeof content === 'string' ? content : content.toString()
      );
      const ev = { filePath, contentHash: hash };
      if (beforeHash) ev.beforeHash = beforeHash;
      return ev;
    },

    /**
     * Build READ_FILE evidence from a file read result.
     * @param {string} filePath
     * @param {string|Buffer} content
     * @returns {Object}
     */
    fileRead(filePath, content) {
      const buf = typeof content === 'string' ? Buffer.from(content) : content;
      return {
        filePath,
        fileSize: buf.length,
        contentHash: ActionEvidenceProtocol.contentHash(buf),
      };
    },

    /**
     * Build SHELL_EXEC evidence from command execution result.
     * @param {string} command
     * @param {number} exitCode
     * @param {string} stdout
     * @returns {Object}
     */
    shellExec(command, exitCode, stdout) {
      return {
        command,
        exitCode,
        stdoutHash: ActionEvidenceProtocol.contentHash(stdout || ''),
      };
    },

    /**
     * Build FETCHED evidence from an HTTP response.
     * @param {string} url
     * @param {number} status
     * @param {string|Buffer} body
     * @returns {Object}
     */
    httpFetch(url, status, body) {
      return {
        url,
        responseStatus: status,
        contentHash: ActionEvidenceProtocol.contentHash(body || ''),
      };
    },

    /**
     * Build SEARCHED evidence from a search result.
     * @param {string} query
     * @param {Array} results
     * @returns {Object}
     */
    search(query, results) {
      const serialized = JSON.stringify(results || []);
      return {
        query,
        resultCount: Array.isArray(results) ? results.length : 0,
        resultsHash: ActionEvidenceProtocol.contentHash(serialized),
      };
    },

    /**
     * Build SENT_MESSAGE evidence from a message post result.
     * @param {string|number} messageId
     * @param {string} channel
     * @returns {Object}
     */
    messageSent(messageId, channel) {
      return { messageId: String(messageId), channel };
    },

    /**
     * Build DEPLOYED evidence from a process check.
     * @param {string} target - Host or system name
     * @param {number} pid
     * @param {number} port
     * @returns {Object}
     */
    deployed(target, pid, port) {
      return {
        target,
        pid: Number(pid),
        port: Number(port),
        timestamp: new Date().toISOString(),
      };
    },

    /**
     * Build COMMITTED evidence from a git commit.
     * @param {string} gitSha
     * @param {string} repository - Path to the git repository
     * @returns {Object}
     */
    committed(gitSha, repository) {
      return { gitSha, repository };
    },

    /**
     * Build FAILED evidence.
     * @param {string} attemptedAction - What verb was attempted
     * @param {string} errorMessage
     * @returns {Object}
     */
    failed(attemptedAction, errorMessage) {
      return { attemptedAction, errorMessage };
    },
  };

  // -------------------------------------------------------------------------
  // Internal methods
  // -------------------------------------------------------------------------

  /**
   * Detect action claims in a message body using pattern matching.
   * Returns an array of { text, verb, position } objects.
   *
   * @param {string} messageBody
   * @returns {Array<{text: string, verb: string, position: number}>}
   * @private
   */
  _detectClaims(messageBody) {
    if (!messageBody || typeof messageBody !== 'string') return [];

    const claims = [];
    const seen = new Set(); // Deduplicate by verb + rough position

    for (const pattern of CLAIM_PATTERNS) {
      // Reset regex state
      pattern.regex.lastIndex = 0;
      let match;

      while ((match = pattern.regex.exec(messageBody)) !== null) {
        const key = `${pattern.verb}:${Math.floor(match.index / 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        claims.push({
          text: match[0].trim(),
          verb: pattern.verb,
          position: match.index,
        });
      }
    }

    // Sort by position in message
    claims.sort((a, b) => a.position - b.position);

    return claims;
  }

  /**
   * Find the best downgrade for a claimed verb based on available evidence.
   * Example: agent claims DEPLOYED but only WROTE_CODE exists → suggest WROTE_CODE.
   *
   * The hierarchy (highest to lowest):
   *   VERIFIED > DEPLOYED > COMMITTED > WROTE_CODE / WROTE_FILE
   *
   * @param {string} claimedVerb - What the agent claimed
   * @param {Set<string>} availableVerbs - What evidence actually exists
   * @returns {string|null} The highest verb in the evidence, or null
   * @private
   */
  _findDowngrade(claimedVerb, availableVerbs) {
    // Define the deployment hierarchy
    const hierarchy = ['VERIFIED', 'DEPLOYED', 'COMMITTED', 'WROTE_CODE', 'WROTE_FILE'];

    const claimedIdx = hierarchy.indexOf(claimedVerb);
    if (claimedIdx === -1) return null; // Not in the hierarchy — no downgrade path

    // Find the highest available verb below the claimed level
    for (let i = claimedIdx + 1; i < hierarchy.length; i++) {
      if (availableVerbs.has(hierarchy[i])) {
        return hierarchy[i];
      }
    }

    return null;
  }

  /**
   * Clean up old in-memory traces to prevent memory leaks.
   * Traces older than maxTraceAge are removed from memory (they persist in DB).
   * @private
   */
  _cleanup() {
    const now = Date.now();
    const expired = [];

    for (const [traceId, trace] of this.traces) {
      const age = now - new Date(trace.startedAt).getTime();
      if (age > this.maxTraceAge) {
        expired.push(traceId);
      }
    }

    for (const traceId of expired) {
      const trace = this.traces.get(traceId);
      if (trace && trace.status === 'active') {
        // Finalize before removal
        this.db.run(
          `UPDATE evidence_traces SET evidence_trail = ?, status = 'expired', completed_at = ? WHERE trace_id = ?`,
          [JSON.stringify(trace.trail), new Date().toISOString(), traceId]
        );
      }
      this.traces.delete(traceId);
    }

    if (expired.length > 0) {
      console.log(`[AEP] Cleaned up ${expired.length} expired trace(s)`);
    }
  }

  /**
   * Start the cleanup interval (runs every 15 minutes).
   * @private
   */
  _startCleanupInterval() {
    this._cleanupTimer = setInterval(() => this._cleanup(), 15 * 60 * 1000);
    // Allow process to exit without waiting for this timer
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * Cross-provider consensus verification of agent claims.
   * Submits the agent's message and evidence trail to two independent LLMs
   * from different providers and requires agreement before marking claims verified.
   *
   * @param {string} traceId - The trace to verify against
   * @param {string} messageBody - The agent's message text
   * @param {Object} llmService - LLM service instance for making calls
   * @param {Object} [opts] - Options
   * @param {string} [opts.localModel] - Local model name (default: env OLLAMA_MODEL)
   * @param {string} [opts.cloudProvider] - Cloud provider name (gemini, anthropic, openai)
   * @param {string} [opts.cloudModel] - Cloud model name
   * @returns {Object} { consensus, localVerdict, cloudVerdict, level }
   */
  async crossProviderVerify(traceId, messageBody, llmService, opts = {}) {
    if (!llmService) return { consensus: 'unavailable', level: 'claimed' };

    const trace = this.traces.get(traceId);
    if (!trace) return { consensus: 'no_trace', level: 'claimed' };

    // Build a compact evidence summary for the LLMs
    const trailSummary = trace.trail.map(e =>
      `[${e.verb}] ${JSON.stringify(e.evidence)} @ ${e.timestamp}`
    ).join('\n');

    const verificationPrompt = `You are an evidence verification system. An AI agent produced a message and the system captured an evidence trail of what the agent actually did. Compare the agent's claims against the evidence.

EVIDENCE TRAIL (system-captured, immutable):
${trailSummary || '(empty — no tool executions recorded)'}

AGENT'S MESSAGE:
"${messageBody.substring(0, 2000)}"

Does the agent's message accurately represent what the evidence shows? Consider:
- Does the agent claim actions (deployed, verified, completed) that the evidence doesn't support?
- Does the evidence contradict any claims?
- Are there claims with no corresponding evidence?

Respond with EXACTLY one word: VERIFIED, PARTIAL, CLAIMED, or CONTRADICTED.`;

    let localVerdict = null;
    let cloudVerdict = null;

    const localModel = opts.localModel || process.env.OLLAMA_MODEL || 'qwen2.5:7b';

    // Model 1: Local LLM
    try {
      const result = await llmService.complete({
        agentId: 'agent_darkhan',
        provider: 'ollama',
        model: localModel,
        messages: [{ role: 'user', content: verificationPrompt }],
        options: { temperature: 0, maxTokens: 10 },
        requestType: 'claim_verification_local',
      });
      const r = result.response.trim().toUpperCase();
      if (r.startsWith('VERIFIED')) localVerdict = 'verified';
      else if (r.startsWith('PARTIAL')) localVerdict = 'partial';
      else if (r.startsWith('CLAIMED')) localVerdict = 'claimed';
      else if (r.startsWith('CONTRADICTED')) localVerdict = 'contradicted';
    } catch (e) {
      console.warn('[AEP] Cross-provider local verification failed:', e.message);
    }

    // Model 2: Cloud LLM (if configured)
    const cloudProvider = opts.cloudProvider || process.env.SECURITY_ESCALATION_PROVIDER;
    const cloudModel = opts.cloudModel || process.env.SECURITY_ESCALATION_MODEL;

    if (cloudProvider) {
      try {
        const result = await llmService.complete({
          agentId: 'agent_darkhan',
          provider: cloudProvider,
          model: cloudModel,
          messages: [{ role: 'user', content: verificationPrompt }],
          options: { temperature: 0, maxTokens: 10 },
          requestType: 'claim_verification_cloud',
        });
        const r = result.response.trim().toUpperCase();
        if (r.startsWith('VERIFIED')) cloudVerdict = 'verified';
        else if (r.startsWith('PARTIAL')) cloudVerdict = 'partial';
        else if (r.startsWith('CLAIMED')) cloudVerdict = 'claimed';
        else if (r.startsWith('CONTRADICTED')) cloudVerdict = 'contradicted';
      } catch (e) {
        console.warn('[AEP] Cross-provider cloud verification failed:', e.message);
      }
    }

    // Consensus logic
    let consensus, level;

    if (localVerdict === null && cloudVerdict === null) {
      consensus = 'unavailable';
      level = 'claimed'; // Fail open but mark as unverified
    } else if (localVerdict === null || cloudVerdict === null) {
      // Single model — use it but mark as single-model
      const solo = localVerdict || cloudVerdict;
      consensus = 'single_model';
      level = solo;
    } else if (localVerdict === cloudVerdict) {
      // Both agree
      consensus = 'agreement';
      level = localVerdict;
    } else {
      // Disagreement — use the more conservative (lower trust) verdict
      const hierarchy = ['contradicted', 'claimed', 'partial', 'verified'];
      const localIdx = hierarchy.indexOf(localVerdict);
      const cloudIdx = hierarchy.indexOf(cloudVerdict);
      consensus = 'disagreement';
      level = hierarchy[Math.min(localIdx, cloudIdx)];
    }

    const result = { consensus, localVerdict, cloudVerdict, level };

    // Log to activity log
    this.activityLog.append({
      actor: 'aep',
      action: 'cross_provider_verification',
      target: trace.agentId,
      details: JSON.stringify({
        traceId,
        consensus,
        localVerdict,
        cloudVerdict,
        level,
      }),
    });

    return result;
  }

  /**
   * Shut down the service cleanly. Persists all active traces.
   */
  shutdown() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }

    // Persist all active traces
    for (const [traceId, trace] of this.traces) {
      if (trace.status === 'active') {
        this.db.run(
          `UPDATE evidence_traces SET evidence_trail = ?, status = 'shutdown', completed_at = ? WHERE trace_id = ?`,
          [JSON.stringify(trace.trail), new Date().toISOString(), traceId]
        );
      }
    }

    this.traces.clear();
    console.log('[AEP] Action-Evidence Protocol shut down');
  }
}

module.exports = { ActionEvidenceProtocol, ACTION_VOCABULARY };
