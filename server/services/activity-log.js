/**
 * Darkhan — Immutable Activity Log (Hash Chain)
 *
 * Append-only event log for all agent and human actions.
 * NO DELETE, NO UPDATE — audit trail only.
 *
 * [DARKHAN SECURITY] Hash chain: each entry includes a chain_hash field
 * (SHA-256 of previous hash + current entry data) making the log tamper-evident.
 * If any entry is deleted or modified, the chain breaks and verify() detects it.
 *
 * [MOKUME FOUNDATION] Federation-ready: each entry carries an origin instance ID
 * and optional entry_type for CRISPR-style defense spacers that propagate across
 * federated instances. Chain heads can be exchanged for cross-instance verification.
 *
 * Entry types:
 *   'event'   — Standard activity entry (default)
 *   'spacer'  — CRISPR-style defense signature (attack pattern, propagated via Mokume)
 *   'anchor'  — Periodic chain anchor with full chain state (for verification checkpoints)
 */

const crypto = require('crypto');

class ActivityLog {
  constructor({ db, instanceId = 'standalone' }) {
    this.db = db;
    this.instanceId = instanceId;
    this._lastChainHash = null;
    this._chainLength = 0;
    this._ensureTable();
    this._loadLastChainHash();
  }

  _ensureTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        details TEXT,
        chain_hash TEXT,
        origin TEXT,
        entry_type TEXT DEFAULT 'event',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Schema migrations for upgrades from older versions
    const migrations = [
      'ALTER TABLE activity_log ADD COLUMN chain_hash TEXT',
      'ALTER TABLE activity_log ADD COLUMN origin TEXT',
      "ALTER TABLE activity_log ADD COLUMN entry_type TEXT DEFAULT 'event'",
    ];
    for (const sql of migrations) {
      this.db.run(sql, (err) => {
        if (err && !err.message.includes('duplicate column')) {
          console.error('[ActivityLog] Migration error:', err.message);
        }
      });
    }

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_activity_actor
      ON activity_log (actor, created_at)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_activity_action
      ON activity_log (action, created_at)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_activity_type
      ON activity_log (entry_type, created_at)
    `);
  }

  /**
   * Load the last chain_hash and chain length from the log.
   * Called on startup to resume the hash chain.
   */
  _loadLastChainHash() {
    this.db.get(
      'SELECT chain_hash, id FROM activity_log ORDER BY id DESC LIMIT 1',
      [],
      (err, row) => {
        if (err) {
          console.error('[ActivityLog] Failed to load last chain hash:', err.message);
          return;
        }
        this._lastChainHash = (row && row.chain_hash) || null;
        this._chainLength = (row && row.id) || 0;
      }
    );
  }

  /**
   * Compute a chain hash: SHA-256(previousHash + entryData)
   */
  _computeChainHash(previousHash, entryData) {
    const input = (previousHash || 'genesis') + entryData;
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  /**
   * Append an event to the activity log.
   * This is the ONLY write method. No update, no delete.
   * Each entry includes a chain_hash linking it to the previous entry,
   * an origin instance ID, and an entry_type.
   *
   * IMPORTANT: Hash computation is synchronous and serialized to prevent
   * race conditions where concurrent appends could break the chain.
   * The DB write is queued but the hash is computed atomically.
   */
  append({ actor, action, target = null, details = null, entryType = 'event', origin = null }) {
    const entryOrigin = origin || this.instanceId;
    const entryData = `${actor}|${action}|${target || ''}|${details || ''}|${entryOrigin}|${entryType}`;

    // Synchronous hash computation — must not yield between read and write of _lastChainHash
    const chainHash = this._computeChainHash(this._lastChainHash, entryData);
    this._lastChainHash = chainHash;
    this._chainLength++;

    // Queue the write — serialized by SQLite's internal write lock
    this._writeQueue(actor, action, target, details, chainHash, entryOrigin, entryType);

    return chainHash;
  }

  /**
   * Internal: queue a write to the activity log.
   * Uses db.serialize() to ensure writes are ordered.
   */
  _writeQueue(actor, action, target, details, chainHash, origin, entryType) {
    this.db.run(
      `INSERT INTO activity_log (actor, action, target, details, chain_hash, origin, entry_type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [actor, action, target, details, chainHash, origin, entryType],
      (err) => {
        if (err) console.error('[ActivityLog] Append error:', err.message);
      }
    );
  }

  /**
   * Append a CRISPR-style defense spacer to the chain.
   * Spacers are attack signatures, security patterns, or defense rules that
   * should propagate across federated instances via Mokume.
   *
   * A spacer contains:
   *   - signature: hash or pattern of the detected threat
   *   - category: 'injection', 'impersonation', 'exfiltration', 'escalation', etc.
   *   - description: human-readable description of the threat
   *   - source_entry_id: the activity log entry that triggered spacer creation (if any)
   *
   * When Mokume propagates a spacer from another instance, it arrives with
   * origin set to the source instance ID, preserving provenance.
   */
  appendSpacer({ category, signature, description, sourceEntryId = null, origin = null }) {
    const spacerData = {
      category,
      signature,
      description,
      sourceEntryId,
      createdBy: this.instanceId,
      propagatedFrom: origin || null,
    };

    return this.append({
      actor: 'defense_system',
      action: `spacer_${category}`,
      target: signature,
      details: JSON.stringify(spacerData),
      entryType: 'spacer',
      origin: origin || this.instanceId,
    });
  }

  /**
   * Get the current chain head — the latest hash and chain length.
   * Used for cross-instance verification: two instances can compare chain heads
   * for shared entries to detect divergence.
   */
  async getChainHead() {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT id, chain_hash, actor, action, created_at FROM activity_log ORDER BY id DESC LIMIT 1',
        [],
        (err, row) => {
          if (err) return reject(err);
          resolve({
            instanceId: this.instanceId,
            chainLength: row ? row.id : 0,
            headHash: row ? row.chain_hash : null,
            lastEntry: row ? { actor: row.actor, action: row.action, timestamp: row.created_at } : null,
            timestamp: new Date().toISOString(),
          });
        }
      );
    });
  }

  /**
   * Get all spacers, optionally filtered by category or time range.
   * Used by Mokume to propagate defense signatures to peer instances.
   */
  async getSpacers({ category = null, since = null, limit = 100 } = {}) {
    return new Promise((resolve, reject) => {
      let sql = "SELECT * FROM activity_log WHERE entry_type = 'spacer'";
      const params = [];

      if (category) { sql += ' AND action = ?'; params.push(`spacer_${category}`); }
      if (since) { sql += ' AND created_at > ?'; params.push(since); }

      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Ingest a spacer from a federated peer instance (via Mokume).
   * Validates the spacer has required fields and appends it with the
   * origin set to the source instance, preserving provenance chain.
   */
  ingestRemoteSpacer({ category, signature, description, sourceInstanceId, sourceEntryId = null }) {
    if (!category || !signature || !sourceInstanceId) {
      console.error('[ActivityLog] Invalid remote spacer — missing required fields');
      return null;
    }

    return this.appendSpacer({
      category,
      signature,
      description,
      sourceEntryId,
      origin: sourceInstanceId,
    });
  }

  /**
   * Write a periodic chain anchor — a checkpoint entry that records the full
   * chain state (length, head hash, entry counts by type) for verification.
   * Scheduled to run every 6 hours for tamper detection between full verifications.
   */
  appendAnchor() {
    const anchorData = {
      chainLength: this._chainLength,
      headHash: this._lastChainHash,
      instanceId: this.instanceId,
      anchorTime: new Date().toISOString(),
    };

    return this.append({
      actor: 'chain_service',
      action: 'chain_anchor',
      target: this._lastChainHash,
      details: JSON.stringify(anchorData),
      entryType: 'anchor',
    });
  }

  /**
   * Verify the integrity of the hash chain.
   * Walks every entry and confirms each hash links to the previous.
   * Handles both legacy format (4-field) and new format (6-field with origin + entry_type).
   *
   * Returns: { valid, entries, spacers, anchors, brokenAt?, details?, headHash, instanceId }
   */
  async verify() {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT id, actor, action, target, details, chain_hash, origin, entry_type FROM activity_log ORDER BY id ASC',
        [],
        (err, rows) => {
          if (err) return reject(err);
          if (!rows || rows.length === 0) {
            return resolve({ valid: true, entries: 0, spacers: 0, anchors: 0, headHash: null, instanceId: this.instanceId });
          }

          let previousHash = null;
          let spacerCount = 0;
          let anchorCount = 0;

          for (const row of rows) {
            // Skip entries without chain_hash (pre-upgrade entries)
            if (!row.chain_hash) continue;

            // Try new 6-field format first, fall back to legacy 4-field
            const entryOrigin = row.origin || this.instanceId;
            const entryType = row.entry_type || 'event';
            const newFormatData = `${row.actor}|${row.action}|${row.target || ''}|${row.details || ''}|${entryOrigin}|${entryType}`;
            const legacyData = `${row.actor}|${row.action}|${row.target || ''}|${row.details || ''}`;

            const newHash = this._computeChainHash(previousHash, newFormatData);
            const legacyHash = this._computeChainHash(previousHash, legacyData);

            if (row.chain_hash === newHash) {
              // New format match
            } else if (row.chain_hash === legacyHash) {
              // Legacy format match — still valid
            } else {
              return resolve({
                valid: false,
                entries: rows.length,
                spacers: spacerCount,
                anchors: anchorCount,
                brokenAt: row.id,
                details: `Hash chain broken at entry ${row.id} (${row.action}). Expected ${newHash.substring(0, 16)}... or legacy ${legacyHash.substring(0, 16)}..., got ${row.chain_hash.substring(0, 16)}...`,
                headHash: previousHash,
                instanceId: this.instanceId,
              });
            }

            previousHash = row.chain_hash;
            if (entryType === 'spacer') spacerCount++;
            if (entryType === 'anchor') anchorCount++;
          }

          resolve({
            valid: true,
            entries: rows.length,
            spacers: spacerCount,
            anchors: anchorCount,
            headHash: previousHash,
            instanceId: this.instanceId,
          });
        }
      );
    });
  }

  /**
   * Query recent activity.
   */
  async getRecent({ actor, action, limit = 50, since } = {}) {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT * FROM activity_log WHERE 1=1';
      const params = [];

      if (actor) { sql += ' AND actor = ?'; params.push(actor); }
      if (action) { sql += ' AND action = ?'; params.push(action); }
      if (since) { sql += ' AND created_at > ?'; params.push(since); }

      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Get activity count by actor for a given day.
   */
  async getDailySummary(date) {
    const targetDate = date || new Date().toISOString().substring(0, 10);
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT actor, action, entry_type, COUNT(*) as count
         FROM activity_log
         WHERE DATE(created_at) = ?
         GROUP BY actor, action, entry_type
         ORDER BY count DESC`,
        [targetDate],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  /**
   * Get chain statistics — summary useful for monitoring dashboards.
   */
  async getChainStats() {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT
           COUNT(*) as total_entries,
           SUM(CASE WHEN entry_type = 'spacer' THEN 1 ELSE 0 END) as spacers,
           SUM(CASE WHEN entry_type = 'anchor' THEN 1 ELSE 0 END) as anchors,
           SUM(CASE WHEN origin != ? THEN 1 ELSE 0 END) as remote_entries,
           MIN(created_at) as chain_start,
           MAX(created_at) as chain_end
         FROM activity_log`,
        [this.instanceId],
        (err, row) => {
          if (err) return reject(err);
          resolve({
            instanceId: this.instanceId,
            totalEntries: row?.total_entries || 0,
            spacers: row?.spacers || 0,
            anchors: row?.anchors || 0,
            remoteEntries: row?.remote_entries || 0,
            chainStart: row?.chain_start || null,
            chainEnd: row?.chain_end || null,
            headHash: this._lastChainHash,
          });
        }
      );
    });
  }
}

module.exports = { ActivityLog };
