/**
 * Darkhan — Observation-Evidence Protocol (OEP)
 *
 * Extension of AEP from actions to observations. AEP answers "did the agent
 * do what it said it did?" OEP answers "did the agent see what it said it saw?"
 *
 * Every diagnostic observation requires:
 *   - Raw signal data (verifiable by the human)
 *   - Interpretation (the agent's conclusion, separate from the signal)
 *   - Confidence level (computed from independent signal count)
 *   - Confidence basis (which signals were checked)
 *   - Alternative interpretation ("could be wrong" field — required)
 *
 * The separation of signal from interpretation is the core innovation. The
 * human sees both and can independently verify the raw signal.
 *
 * Integration points:
 *   - worker-runtime.js: agents can record observations via context.observe()
 *   - auto-responder.js: human communication observations (optional)
 *   - maintenance.js: system observations (process state, resource pressure)
 *   - Shares evidence_traces table with AEP (observation records stored alongside action records)
 *
 * Patent claims: 18-20 in the Darkhan provisional patent.
 */

const crypto = require('crypto');
const { execSync } = require('child_process');
const os = require('os');

// ---------------------------------------------------------------------------
// Observation Vocabulary — structured types with required signal schemas
// ---------------------------------------------------------------------------

const OBSERVATION_TYPES = {
  // --- System Observations ---
  PROCESS_IDLE: {
    type: 'PROCESS_IDLE',
    category: 'system',
    description: 'Process is alive but not computing — 0% CPU for extended period',
    requiredSignals: ['pid', 'cpuPercent', 'durationSeconds'],
    humanAnalogy: 'Person staring at wall',
  },

  PROCESS_BUSY: {
    type: 'PROCESS_BUSY',
    category: 'system',
    description: 'Process is actively computing — sustained high CPU',
    requiredSignals: ['pid', 'cpuPercent', 'durationSeconds'],
    humanAnalogy: 'Person working intensely',
  },

  PROCESS_ABSENT: {
    type: 'PROCESS_ABSENT',
    category: 'system',
    description: 'Expected service or process is not running',
    requiredSignals: ['expectedProcess', 'searchMethod'],
    humanAnalogy: 'Person did not show up',
  },

  PROCESS_DUPLICATE: {
    type: 'PROCESS_DUPLICATE',
    category: 'system',
    description: 'Multiple instances of a service that should be singleton',
    requiredSignals: ['processName', 'pidList', 'expectedCount'],
    humanAnalogy: 'Two people doing the same job',
  },

  LOG_SILENCE: {
    type: 'LOG_SILENCE',
    category: 'system',
    description: 'Expected log entry absent for longer than baseline',
    requiredSignals: ['expectedPattern', 'silenceDurationSeconds', 'logSource'],
    humanAnalogy: 'Conversation went quiet',
  },

  LOG_STORM: {
    type: 'LOG_STORM',
    category: 'system',
    description: 'Excessive repeated log entries indicating a loop or flood',
    requiredSignals: ['pattern', 'countPerSecond', 'durationSeconds', 'logSource'],
    humanAnalogy: 'Someone repeating themselves frantically',
  },

  LOG_SEQUENCE_BREAK: {
    type: 'LOG_SEQUENCE_BREAK',
    category: 'system',
    description: 'Expected sequence of log entries has a gap — a step was skipped',
    requiredSignals: ['expectedSequence', 'actualSequence', 'missingStep', 'logSource'],
    humanAnalogy: 'Someone skipped a word mid-sentence',
  },

  TIMING_ANOMALY: {
    type: 'TIMING_ANOMALY',
    category: 'system',
    description: 'Response or operation took significantly longer than baseline',
    requiredSignals: ['operation', 'actualMs', 'baselineMs', 'deviationFactor'],
    humanAnalogy: 'Long pause before answering',
  },

  RESOURCE_PRESSURE: {
    type: 'RESOURCE_PRESSURE',
    category: 'system',
    description: 'System resource trending toward exhaustion',
    requiredSignals: ['resource', 'currentValue', 'threshold', 'unit', 'trend'],
    humanAnalogy: 'Someone getting increasingly stressed',
  },

  CONNECTION_LOST: {
    type: 'CONNECTION_LOST',
    category: 'system',
    description: 'Expected network connection dropped or timed out',
    requiredSignals: ['target', 'lastSeenAt', 'errorType'],
    humanAnalogy: 'Someone hung up',
  },

  ERROR_DIAGNOSTIC: {
    type: 'ERROR_DIAGNOSTIC',
    category: 'system',
    description: 'Error message itself reveals the root cause',
    requiredSignals: ['errorMessage', 'errorType', 'sourceComponent'],
    humanAnalogy: 'Tone of voice reveals emotion',
  },

  // --- Behavioral Observations (Agent-to-Agent) ---
  CAPABILITY_GAP: {
    type: 'CAPABILITY_GAP',
    category: 'behavioral',
    description: 'Agent cannot perform the task but deflects rather than admitting it',
    requiredSignals: ['agentId', 'requestedAction', 'actualResponse'],
    humanAnalogy: 'Deflection instead of honest admission',
  },

  QUALITY_DECLINE: {
    type: 'QUALITY_DECLINE',
    category: 'behavioral',
    description: 'Agent output quality degrading over session — shorter, less detailed',
    requiredSignals: ['agentId', 'metricName', 'baselineValue', 'currentValue', 'windowSize'],
    humanAnalogy: 'Getting tired, answers getting shorter',
  },

  PATTERN_SHIFT: {
    type: 'PATTERN_SHIFT',
    category: 'behavioral',
    description: 'Agent tool usage or behavior pattern changed from established baseline',
    requiredSignals: ['agentId', 'patternName', 'baselinePattern', 'currentPattern'],
    humanAnalogy: 'Suddenly doing things differently',
  },

  CONFIDENCE_MISMATCH: {
    type: 'CONFIDENCE_MISMATCH',
    category: 'behavioral',
    description: 'Agent makes strong assertion with no evidence trail backing it',
    requiredSignals: ['agentId', 'assertion', 'evidenceTrailEmpty'],
    humanAnalogy: 'Speaking with certainty about something they could not know',
  },

  // --- Human Communication Observations ---
  THINKING_MODE: {
    type: 'THINKING_MODE',
    category: 'communication',
    description: 'Human is ideating — long message, multiple questions, exploratory language',
    requiredSignals: ['messageLength', 'questionCount', 'exploratoryMarkers'],
    humanAnalogy: 'Thinking out loud, match depth not speed',
  },

  DIRECTING_MODE: {
    type: 'DIRECTING_MODE',
    category: 'communication',
    description: 'Human knows what they want — short imperative message',
    requiredSignals: ['messageLength', 'imperativeVerbs'],
    humanAnalogy: 'Giving orders, execute quickly',
  },

  PIVOT_SIGNAL: {
    type: 'PIVOT_SIGNAL',
    category: 'communication',
    description: 'Human is changing direction — "wait", "actually", "before that"',
    requiredSignals: ['pivotMarker', 'messageContext'],
    humanAnalogy: 'Better idea forming, pause current path',
  },

  FATIGUE_SIGNAL: {
    type: 'FATIGUE_SIGNAL',
    category: 'communication',
    description: 'Human showing signs of fatigue — late hour, shorter messages',
    requiredSignals: ['localHour', 'avgMessageLength', 'recentMessageLength'],
    humanAnalogy: 'Human needs a break, be efficient',
  },
};


// ---------------------------------------------------------------------------
// Confidence levels — computed from signal independence
// ---------------------------------------------------------------------------

const CONFIDENCE_LEVELS = {
  LOW: { label: 'low', minSignals: 1, description: 'Single signal — could be noise' },
  MEDIUM: { label: 'medium', minSignals: 2, description: 'Two independent signals agree' },
  HIGH: { label: 'high', minSignals: 3, description: 'Three or more independent signals agree' },
};

function computeConfidence(signalCount) {
  if (signalCount >= 3) return CONFIDENCE_LEVELS.HIGH;
  if (signalCount >= 2) return CONFIDENCE_LEVELS.MEDIUM;
  return CONFIDENCE_LEVELS.LOW;
}


// ---------------------------------------------------------------------------
// ObservationEvidenceProtocol — the main service class
// ---------------------------------------------------------------------------

class ObservationEvidenceProtocol {
  /**
   * @param {Object} opts
   * @param {Object} opts.activityLog - Immutable activity log instance
   * @param {Object} opts.db - SQLite database instance
   * @param {Object} [opts.aep] - ActionEvidenceProtocol instance (for shared traces)
   */
  constructor({ activityLog, db, aep }) {
    if (!activityLog) throw new Error('OEP requires activityLog');
    if (!db) throw new Error('OEP requires db');

    this.activityLog = activityLog;
    this.db = db;
    this.aep = aep || null;

    this._ensureTable();

    console.log('[OEP] Observation-Evidence Protocol initialized');
  }

  // -------------------------------------------------------------------------
  // Database setup
  // -------------------------------------------------------------------------

  _ensureTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS observation_records (
        id TEXT PRIMARY KEY,
        trace_id TEXT,
        agent_id TEXT NOT NULL,
        observation_type TEXT NOT NULL,
        category TEXT NOT NULL,
        signals TEXT NOT NULL,
        interpretation TEXT NOT NULL,
        confidence TEXT NOT NULL,
        confidence_basis TEXT NOT NULL,
        alternative_interpretation TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        hash TEXT NOT NULL,
        verified_by_human INTEGER DEFAULT 0,
        human_selected_alternative INTEGER DEFAULT 0
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_observations_agent
        ON observation_records(agent_id)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_observations_type
        ON observation_records(observation_type)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_observations_trace
        ON observation_records(trace_id)
    `);
  }

  // -------------------------------------------------------------------------
  // Core: Record an observation
  // -------------------------------------------------------------------------

  /**
   * Record a structured observation. This is the primary interface for agents.
   *
   * @param {Object} obs
   * @param {string} obs.agentId - Who made the observation
   * @param {string} obs.type - One of OBSERVATION_TYPES keys
   * @param {Object} obs.signals - Raw signal data (must contain required fields for the type)
   * @param {string} obs.interpretation - What the agent thinks the signals mean
   * @param {string} obs.alternativeInterpretation - At least one "could be wrong" explanation (REQUIRED)
   * @param {string} [obs.traceId] - Link to an AEP trace if this observation is part of a task
   * @param {string[]} [obs.independentSignals] - List of which signals are independent (for confidence calc)
   * @returns {Object} The stored observation record
   * @throws {Error} If type is unknown, required signals are missing, or alternative is missing
   */
  record(obs) {
    // Validate observation type
    const typeDef = OBSERVATION_TYPES[obs.type];
    if (!typeDef) {
      throw new Error(`Unknown observation type: ${obs.type}. Valid types: ${Object.keys(OBSERVATION_TYPES).join(', ')}`);
    }

    // Validate required signals
    const missing = typeDef.requiredSignals.filter(s => !(s in (obs.signals || {})));
    if (missing.length > 0) {
      throw new Error(`Observation ${obs.type} missing required signals: ${missing.join(', ')}`);
    }

    // REQUIRE alternative interpretation — this is not optional
    if (!obs.alternativeInterpretation || obs.alternativeInterpretation.trim().length === 0) {
      throw new Error('Observation requires an alternative interpretation ("could be wrong" field). This is mandatory.');
    }

    // Require interpretation
    if (!obs.interpretation || obs.interpretation.trim().length === 0) {
      throw new Error('Observation requires an interpretation');
    }

    // Compute confidence from independent signal count
    const independentSignals = obs.independentSignals || Object.keys(obs.signals);
    const confidence = computeConfidence(independentSignals.length);

    // Build confidence basis
    const confidenceBasis = `${independentSignals.length} independent signal(s): ${independentSignals.join(', ')}`;

    const timestamp = new Date().toISOString();
    const id = `oep_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    // Tamper-evident hash
    const hashInput = `${id}|${obs.type}|${JSON.stringify(obs.signals)}|${obs.interpretation}|${obs.alternativeInterpretation}|${timestamp}`;
    const hash = crypto.createHash('sha256').update(hashInput).digest('hex');

    const record = {
      id,
      traceId: obs.traceId || null,
      agentId: obs.agentId,
      type: obs.type,
      category: typeDef.category,
      signals: obs.signals,
      interpretation: obs.interpretation,
      confidence: confidence.label,
      confidenceBasis,
      alternativeInterpretation: obs.alternativeInterpretation,
      timestamp,
      hash,
    };

    // Persist to DB
    this.db.run(
      `INSERT INTO observation_records
        (id, trace_id, agent_id, observation_type, category, signals, interpretation,
         confidence, confidence_basis, alternative_interpretation, timestamp, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        record.traceId,
        record.agentId,
        record.type,
        record.category,
        JSON.stringify(record.signals),
        record.interpretation,
        record.confidence,
        record.confidenceBasis,
        record.alternativeInterpretation,
        record.timestamp,
        record.hash,
      ]
    );

    // Log to activity log
    this.activityLog.append({
      actor: 'oep',
      action: 'observation_recorded',
      target: obs.agentId,
      details: JSON.stringify({
        id,
        type: obs.type,
        confidence: confidence.label,
        traceId: record.traceId,
        hash,
      }),
    });

    // If linked to an AEP trace, record a reference in the AEP trail
    if (this.aep && obs.traceId) {
      try {
        this.aep.recordEvidence(obs.traceId, 'ANALYZED', {
          sourceRef: `oep:${id}`,
          reasoning: `Observation ${obs.type}: ${obs.interpretation} (confidence: ${confidence.label})`,
        });
      } catch (_) {
        // Trace may be completed or expired — non-fatal
      }
    }

    return record;
  }

  // -------------------------------------------------------------------------
  // System observation helpers — capture common system signals automatically
  // -------------------------------------------------------------------------

  /**
   * Check if a process is idle (alive but 0% CPU).
   * Returns a structured observation if idle, null otherwise.
   */
  checkProcessIdle(agentId, pid, traceId) {
    try {
      // Check if PID exists
      process.kill(Number(pid), 0);

      // Get CPU usage via ps
      const psOutput = execSync(`ps -p ${pid} -o %cpu=`, { encoding: 'utf8', timeout: 5000 }).trim();
      const cpuPercent = parseFloat(psOutput) || 0;

      if (cpuPercent < 1.0) {
        // Check how long it's been idle (approximate via elapsed time)
        const elapsed = execSync(`ps -p ${pid} -o etime=`, { encoding: 'utf8', timeout: 5000 }).trim();

        return this.record({
          agentId,
          type: 'PROCESS_IDLE',
          signals: { pid: Number(pid), cpuPercent, durationSeconds: this._parseElapsed(elapsed) },
          interpretation: `Process ${pid} is alive but at ${cpuPercent}% CPU — likely stuck or waiting`,
          alternativeInterpretation: 'Process might be waiting on I/O (CPU shows 0% during I/O wait) or legitimately idle between tasks',
          independentSignals: ['pid', 'cpuPercent', 'durationSeconds'],
          traceId,
        });
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Check if an expected process is absent.
   */
  checkProcessAbsent(agentId, processPattern, traceId) {
    try {
      const result = execSync(`pgrep -fl "${processPattern}" 2>/dev/null || true`, { encoding: 'utf8', timeout: 5000 }).trim();
      if (!result || result.length === 0) {
        return this.record({
          agentId,
          type: 'PROCESS_ABSENT',
          signals: { expectedProcess: processPattern, searchMethod: `pgrep -fl "${processPattern}"` },
          interpretation: `Expected process matching "${processPattern}" is not running`,
          alternativeInterpretation: 'Process might be running under a different name, or pgrep pattern might be too narrow',
          independentSignals: ['expectedProcess', 'searchMethod'],
          traceId,
        });
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Check system resource pressure (memory).
   */
  checkResourcePressure(agentId, traceId) {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedPercent = ((totalMem - freeMem) / totalMem * 100).toFixed(1);

    if (parseFloat(usedPercent) > 85) {
      return this.record({
        agentId,
        type: 'RESOURCE_PRESSURE',
        signals: {
          resource: 'memory',
          currentValue: parseFloat(usedPercent),
          threshold: 85,
          unit: 'percent',
          trend: 'unknown',
        },
        interpretation: `Memory usage at ${usedPercent}% — approaching pressure zone`,
        alternativeInterpretation: 'Might be normal for this workload if large models are loaded (Ollama 14B uses ~10GB)',
        independentSignals: ['resource', 'currentValue'],
        traceId,
      });
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Query observations
  // -------------------------------------------------------------------------

  /**
   * Get all observations for a trace.
   */
  getByTrace(traceId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM observation_records WHERE trace_id = ? ORDER BY timestamp ASC',
        [traceId],
        (err, rows) => {
          if (err) return reject(err);
          resolve((rows || []).map(r => this._deserializeRow(r)));
        }
      );
    });
  }

  /**
   * Get recent observations for an agent.
   */
  getByAgent(agentId, limit = 50) {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM observation_records WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?',
        [agentId, limit],
        (err, rows) => {
          if (err) return reject(err);
          resolve((rows || []).map(r => this._deserializeRow(r)));
        }
      );
    });
  }

  /**
   * Get observations by type across all agents.
   */
  getByType(type, limit = 50) {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM observation_records WHERE observation_type = ? ORDER BY timestamp DESC LIMIT ?',
        [type, limit],
        (err, rows) => {
          if (err) return reject(err);
          resolve((rows || []).map(r => this._deserializeRow(r)));
        }
      );
    });
  }

  /**
   * Record that a human verified an observation and optionally selected the alternative.
   */
  recordHumanVerification(observationId, selectedAlternative = false) {
    this.db.run(
      `UPDATE observation_records SET verified_by_human = 1, human_selected_alternative = ? WHERE id = ?`,
      [selectedAlternative ? 1 : 0, observationId]
    );

    this.activityLog.append({
      actor: 'oep',
      action: 'human_verified_observation',
      target: observationId,
      details: JSON.stringify({ selectedAlternative }),
    });
  }

  /**
   * Get observation accuracy stats — how often the primary vs alternative interpretation was correct.
   */
  getAccuracyStats() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT observation_type,
                COUNT(*) as total,
                SUM(verified_by_human) as human_verified,
                SUM(human_selected_alternative) as alternative_selected
         FROM observation_records
         GROUP BY observation_type`,
        [],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  }

  // -------------------------------------------------------------------------
  // Format observations for display
  // -------------------------------------------------------------------------

  /**
   * Format an observation for channel display.
   * Shows the signal, interpretation, confidence, and alternative in a readable format.
   */
  formatForDisplay(record) {
    const typeDef = OBSERVATION_TYPES[record.type] || {};
    const signals = typeof record.signals === 'string' ? JSON.parse(record.signals) : record.signals;

    const signalSummary = Object.entries(signals)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');

    return [
      `**OBSERVED: ${record.type}** — ${signalSummary}`,
      `Interpretation: ${record.interpretation}`,
      `Confidence: ${record.confidence.toUpperCase()} (${record.confidenceBasis})`,
      `Could be wrong: ${record.alternativeInterpretation}`,
    ].join('\n');
  }

  /**
   * Format observations for LLM context — compact, no markdown.
   */
  formatForLLM(records) {
    if (!records || records.length === 0) return '';

    return records.map(r => {
      const signals = typeof r.signals === 'string' ? JSON.parse(r.signals) : r.signals;
      return `[${r.type}] signals=${JSON.stringify(signals)} interpretation="${r.interpretation}" confidence=${r.confidence} alt="${r.alternativeInterpretation}"`;
    }).join('\n');
  }

  // -------------------------------------------------------------------------
  // Vocabulary access
  // -------------------------------------------------------------------------

  /**
   * Get the observation vocabulary with definitions and required signals.
   */
  getVocabulary() {
    return {
      types: Object.values(OBSERVATION_TYPES).map(t => ({
        type: t.type,
        category: t.category,
        description: t.description,
        requiredSignals: t.requiredSignals,
        humanAnalogy: t.humanAnalogy,
      })),
      confidenceLevels: Object.values(CONFIDENCE_LEVELS),
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  _deserializeRow(row) {
    return {
      id: row.id,
      traceId: row.trace_id,
      agentId: row.agent_id,
      type: row.observation_type,
      category: row.category,
      signals: JSON.parse(row.signals || '{}'),
      interpretation: row.interpretation,
      confidence: row.confidence,
      confidenceBasis: row.confidence_basis,
      alternativeInterpretation: row.alternative_interpretation,
      timestamp: row.timestamp,
      hash: row.hash,
      verifiedByHuman: !!row.verified_by_human,
      humanSelectedAlternative: !!row.human_selected_alternative,
    };
  }

  _parseElapsed(elapsed) {
    // Parse ps etime format: [[dd-]hh:]mm:ss
    const parts = elapsed.replace(/-/g, ':').split(':').reverse();
    let seconds = parseInt(parts[0] || '0');
    if (parts[1]) seconds += parseInt(parts[1]) * 60;
    if (parts[2]) seconds += parseInt(parts[2]) * 3600;
    if (parts[3]) seconds += parseInt(parts[3]) * 86400;
    return seconds;
  }

  /**
   * Clean shutdown.
   */
  shutdown() {
    console.log('[OEP] Observation-Evidence Protocol shut down');
  }
}

module.exports = { ObservationEvidenceProtocol, OBSERVATION_TYPES, CONFIDENCE_LEVELS };
