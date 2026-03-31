/**
 * Darkhan — Ground Truth Registry
 *
 * Curated registry of verified facts that agents must reference, not invent.
 * This is the "never-lie" architecture's source of truth.
 *
 * Ground truths are categorized:
 *   - 'metric'   — Numeric values (efficiency, density, counts)
 *   - 'state'    — Current states (deployed, pending, blocked)
 *   - 'identity' — Entity facts (names, roles, relationships)
 *   - 'spec'     — Technical specifications (operating ranges, materials)
 *
 * Each ground truth has:
 *   - key:        Unique identifier (e.g., "server.uptime_target")
 *   - value:      The verified value
 *   - unit:       Unit of measurement (if applicable)
 *   - source:     Where this fact comes from (audit, paper, measurement)
 *   - verified_by: Who verified it (human admin, Corey audit, etc.)
 *   - aliases:    Alternate phrasings that should match (for claim checking)
 *
 * Integration:
 *   - ClaimVerifierService checks agent messages against this registry
 *   - Agents can query the registry via API to get correct values
 *   - Mismatches are flagged as "contradicts ground truth" (not silently corrected)
 *   - Admin manages entries via API (add, update, deprecate)
 *
 * Storage: SQLite table in darkhan.db (not secrets.db — these are shared facts)
 */

const crypto = require('crypto');

class GroundTruthRegistry {
  constructor({ db, activityLog }) {
    this.db = db;
    this.activityLog = activityLog;
    this._cache = new Map(); // key -> entry, refreshed on write
    this._aliasIndex = new Map(); // normalized alias -> key
    this._ensureTable();
    this._loadCache();
  }

  _ensureTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ground_truths (
        key TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK(category IN ('metric', 'state', 'identity', 'spec')),
        value TEXT NOT NULL,
        unit TEXT,
        source TEXT NOT NULL,
        verified_by TEXT NOT NULL,
        aliases TEXT,
        notes TEXT,
        deprecated INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_gt_category
      ON ground_truths (category, deprecated)
    `);
  }

  /**
   * Load all active ground truths into memory for fast claim checking.
   * Called on startup and after any write operation.
   */
  _loadCache() {
    this.db.all(
      'SELECT * FROM ground_truths WHERE deprecated = 0',
      [],
      (err, rows) => {
        if (err) {
          console.error('[GroundTruth] Cache load error:', err.message);
          return;
        }

        this._cache.clear();
        this._aliasIndex.clear();

        for (const row of (rows || [])) {
          this._cache.set(row.key, row);

          // Index the key itself
          this._aliasIndex.set(this._normalize(row.key), row.key);

          // Index aliases
          if (row.aliases) {
            try {
              const aliases = JSON.parse(row.aliases);
              for (const alias of aliases) {
                this._aliasIndex.set(this._normalize(alias), row.key);
              }
            } catch (e) { /* invalid JSON, skip */ }
          }
        }

        console.log(`[GroundTruth] Cache loaded: ${this._cache.size} entries, ${this._aliasIndex.size} aliases`);
      }
    );
  }

  /**
   * Normalize a string for fuzzy matching against aliases.
   * Lowercases, strips special chars, collapses whitespace.
   */
  _normalize(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9\s.%]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Register a new ground truth. Requires source and verifier.
   * Returns the created entry.
   */
  async register({ key, category, value, unit = null, source, verifiedBy, aliases = [], notes = null }) {
    if (!key || !category || value === undefined || !source || !verifiedBy) {
      throw new Error('key, category, value, source, and verifiedBy are required');
    }

    const aliasJson = aliases.length > 0 ? JSON.stringify(aliases) : null;

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO ground_truths (key, category, value, unit, source, verified_by, aliases, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           unit = excluded.unit,
           source = excluded.source,
           verified_by = excluded.verified_by,
           aliases = excluded.aliases,
           notes = excluded.notes,
           deprecated = 0,
           updated_at = CURRENT_TIMESTAMP`,
        [key, category, String(value), unit, source, verifiedBy, aliasJson, notes],
        (err) => {
          if (err) return reject(err);

          this.activityLog.append({
            actor: verifiedBy,
            action: 'ground_truth_registered',
            target: key,
            details: JSON.stringify({ category, value, unit, source }),
          });

          this._loadCache();
          resolve({ key, category, value, unit, source, verifiedBy, aliases });
        }
      );
    });
  }

  /**
   * Deprecate a ground truth (soft delete). Keeps the record for audit trail.
   */
  async deprecate(key, reason, deprecatedBy) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE ground_truths SET deprecated = 1, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?`,
        [`Deprecated: ${reason}`, key],
        function (err) {
          if (err) return reject(err);
          if (this.changes === 0) return reject(new Error(`Ground truth '${key}' not found`));
          resolve({ key, deprecated: true, reason });
        }
      );

      this.activityLog.append({
        actor: deprecatedBy || 'unknown',
        action: 'ground_truth_deprecated',
        target: key,
        details: JSON.stringify({ reason }),
      });

      this._loadCache();
    });
  }

  /**
   * Get a specific ground truth by key.
   */
  get(key) {
    return this._cache.get(key) || null;
  }

  /**
   * Get all active ground truths, optionally filtered by category.
   */
  async getAll({ category = null } = {}) {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT * FROM ground_truths WHERE deprecated = 0';
      const params = [];
      if (category) {
        sql += ' AND category = ?';
        params.push(category);
      }
      sql += ' ORDER BY category, key';
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Check an agent message for claims that reference ground truths.
   * Returns an array of match results:
   *   { key, claimed, registered, matches, evidence }
   *
   * This is called by ClaimVerifierService to add ground truth checks
   * to the existing claim verification pipeline.
   *
   * Performance target: <50ms for a typical message.
   */
  checkMessage(messageBody) {
    const results = [];
    const normalizedBody = this._normalize(messageBody);

    for (const [normalizedAlias, truthKey] of this._aliasIndex) {
      // Skip very short aliases (too many false positives)
      if (normalizedAlias.length < 4) continue;

      if (normalizedBody.includes(normalizedAlias)) {
        const truth = this._cache.get(truthKey);
        if (!truth) continue;

        // Found a reference to a ground truth — now check if the message
        // contains a value that contradicts the registered value
        const contradiction = this._checkContradiction(messageBody, truth);

        results.push({
          key: truthKey,
          category: truth.category,
          registeredValue: truth.value,
          registeredUnit: truth.unit,
          source: truth.source,
          contradiction,
          evidence: contradiction
            ? `Agent claims "${contradiction.claimedValue}" but ground truth is "${truth.value}${truth.unit ? ' ' + truth.unit : ''}"`
            : `Reference matches ground truth (${truth.value}${truth.unit ? ' ' + truth.unit : ''})`,
        });
      }
    }

    return results;
  }

  /**
   * Check if the message contains a value that contradicts a ground truth.
   * For metrics: extracts nearby numbers and compares.
   * For states: checks for contradictory state words.
   * Returns { claimedValue, registeredValue } if contradiction found, null otherwise.
   */
  _checkContradiction(body, truth) {
    if (truth.category === 'metric') {
      return this._checkMetricContradiction(body, truth);
    }
    if (truth.category === 'state') {
      return this._checkStateContradiction(body, truth);
    }
    return null;
  }

  /**
   * For metric ground truths: find numbers near the alias mention and compare.
   * Uses a window of ±60 characters around the alias match.
   * Prefers numbers that appear with matching units or immediately adjacent to the alias.
   */
  _checkMetricContradiction(body, truth) {
    const registeredNum = parseFloat(truth.value);
    if (isNaN(registeredNum)) return null;

    // Find where the truth is referenced in the body
    const aliases = [truth.key];
    try {
      if (truth.aliases) aliases.push(...JSON.parse(truth.aliases));
    } catch (e) { /* */ }

    for (const alias of aliases) {
      const idx = body.toLowerCase().indexOf(alias.toLowerCase());
      if (idx === -1) continue;

      // Extract window around the match — tighter window to reduce false positives
      const start = Math.max(0, idx - 40);
      const end = Math.min(body.length, idx + alias.length + 40);
      const window = body.substring(start, end);

      // Find numbers in the window. Pattern captures number + optional unit.
      // Match "47%", "47 %", "47 percent", "12 patents", "5x", etc.
      // Negative lookbehind: exclude numbers that are part of alphanumeric tokens (e.g., "LR8", "P5")
      const numberPattern = /(?<![A-Za-z])(\d+\.?\d*)\s*(%|percent|patents?|x|g\s*(?:H2)?\/L|kW|MW|°C|deg\s*C|hours?|days?|workers?|K\s*USD)?/gi;
      let numMatch;
      const candidates = [];

      while ((numMatch = numberPattern.exec(window)) !== null) {
        const claimedNum = parseFloat(numMatch[1]);
        if (isNaN(claimedNum)) continue;

        const claimedUnit = (numMatch[2] || '').trim();
        const truthUnit = truth.unit || '';

        // Score this candidate by proximity to the alias
        const numPos = start + numMatch.index;
        const distance = Math.abs(numPos - idx);

        candidates.push({ claimedNum, claimedUnit, distance, truthUnit, fullMatch: numMatch[0] });
      }

      // Sort by distance (closest to alias first)
      candidates.sort((a, b) => a.distance - b.distance);

      for (const cand of candidates) {
        // If both have units, they must be compatible
        if (cand.truthUnit && cand.claimedUnit && !this._unitsCompatible(cand.truthUnit, cand.claimedUnit)) continue;

        // Allow a tolerance band — tighter for high-precision values
        // For values > 99 (like 99.99% purity), use absolute tolerance
        const tolerance = registeredNum > 99
          ? 0.1  // absolute: 99.99 ± 0.1
          : Math.abs(registeredNum * 0.05);  // 5% relative for everything else
        if (Math.abs(cand.claimedNum - registeredNum) > tolerance && cand.claimedNum !== registeredNum) {
          // Same order of magnitude check to avoid false positives
          if (registeredNum === 0 || (cand.claimedNum > registeredNum * 0.1 && cand.claimedNum < registeredNum * 10)) {
            return {
              claimedValue: `${cand.claimedNum}${cand.claimedUnit ? ' ' + cand.claimedUnit : ''}`,
              registeredValue: `${truth.value}${truth.unit ? ' ' + truth.unit : ''}`,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * For state ground truths: check if the message claims a contradictory state.
   */
  _checkStateContradiction(body, truth) {
    const stateOpposites = {
      'deployed': ['not deployed', 'undeployed', 'planned', 'designed'],
      'operational': ['offline', 'down', 'not operational', 'broken'],
      'complete': ['incomplete', 'in progress', 'pending', 'not complete'],
      'blocked': ['unblocked', 'resolved', 'cleared'],
      'active': ['inactive', 'disabled', 'stopped'],
      'pending': ['complete', 'done', 'resolved', 'approved'],
      'filed': ['not filed', 'unfiled', 'drafted'],
    };

    const registeredState = truth.value.toLowerCase();
    const opposites = stateOpposites[registeredState] || [];

    const lowerBody = body.toLowerCase();
    for (const opposite of opposites) {
      // Look for the opposite state near the truth's key/aliases
      const aliases = [truth.key];
      try {
        if (truth.aliases) aliases.push(...JSON.parse(truth.aliases));
      } catch (e) { /* */ }

      for (const alias of aliases) {
        const idx = lowerBody.indexOf(alias.toLowerCase());
        if (idx === -1) continue;

        const start = Math.max(0, idx - 60);
        const end = Math.min(lowerBody.length, idx + alias.length + 60);
        const window = lowerBody.substring(start, end);

        if (window.includes(opposite)) {
          return {
            claimedValue: opposite,
            registeredValue: truth.value,
          };
        }
      }
    }

    return null;
  }

  /**
   * Check if two unit strings are compatible for comparison.
   */
  _unitsCompatible(unit1, unit2) {
    const normalize = (u) => u.toLowerCase().replace(/[^a-z0-9/%]/g, '');
    const n1 = normalize(unit1);
    const n2 = normalize(unit2);

    if (n1 === n2) return true;

    // Common equivalences
    const groups = [
      ['%', 'percent'],
      ['g/l', 'gh2/l', 'gl'],
      ['kw', 'kilowatt'],
      ['mw', 'megawatt'],
      ['c', 'celsius', 'degc'],
    ];

    for (const group of groups) {
      if (group.includes(n1) && group.includes(n2)) return true;
    }

    return false;
  }

  /**
   * Generate a context brief of all ground truths for agent dispatch.
   * This is what agents receive so they know the canonical values.
   */
  async generateBrief() {
    const truths = await this.getAll();

    const sections = { metric: [], state: [], identity: [], spec: [] };
    for (const t of truths) {
      const line = `- **${t.key}**: ${t.value}${t.unit ? ' ' + t.unit : ''} (source: ${t.source})`;
      sections[t.category]?.push(line);
    }

    const parts = [];
    if (sections.metric.length) parts.push(`### Verified Metrics\n${sections.metric.join('\n')}`);
    if (sections.state.length) parts.push(`### Current States\n${sections.state.join('\n')}`);
    if (sections.identity.length) parts.push(`### Identity Facts\n${sections.identity.join('\n')}`);
    if (sections.spec.length) parts.push(`### Technical Specs\n${sections.spec.join('\n')}`);

    return `## Ground Truth Registry\n\nThese values are verified. Do not contradict them. If you believe a value is wrong, flag it — do not silently use a different number.\n\n${parts.join('\n\n')}`;
  }
}

module.exports = { GroundTruthRegistry };
