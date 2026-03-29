/**
 * Darkhan — Immutable Activity Log
 *
 * Append-only event log for all agent and human actions.
 * NO DELETE, NO UPDATE — audit trail only.
 *
 * [DARKHAN SECURITY] Hash chain: each entry includes a chain_hash field
 * (SHA-256 of previous hash + current entry data) making the log tamper-evident.
 * If any entry is deleted or modified, the chain breaks and verify() detects it.
 */

const crypto = require('crypto');

class ActivityLog {
  constructor({ db }) {
    this.db = db;
    this._lastChainHash = null;
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add chain_hash column if upgrading from older schema
    this.db.run(`ALTER TABLE activity_log ADD COLUMN chain_hash TEXT`, (err) => {
      // Ignore "duplicate column" errors — expected on existing installs
      if (err && !err.message.includes('duplicate column')) {
        console.error('[ActivityLog] Column migration error:', err.message);
      }
    });

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_activity_actor
      ON activity_log (actor, created_at)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_activity_action
      ON activity_log (action, created_at)
    `);
  }

  /**
   * Load the last chain_hash from the most recent log entry.
   * Called on startup to resume the hash chain.
   */
  _loadLastChainHash() {
    this.db.get(
      'SELECT chain_hash FROM activity_log ORDER BY id DESC LIMIT 1',
      [],
      (err, row) => {
        if (err) {
          console.error('[ActivityLog] Failed to load last chain hash:', err.message);
          return;
        }
        this._lastChainHash = (row && row.chain_hash) || null;
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
   * Each entry includes a chain_hash linking it to the previous entry.
   */
  append({ actor, action, target = null, details = null }) {
    const entryData = `${actor}|${action}|${target || ''}|${details || ''}`;
    const chainHash = this._computeChainHash(this._lastChainHash, entryData);
    this._lastChainHash = chainHash;

    this.db.run(
      `INSERT INTO activity_log (actor, action, target, details, chain_hash) VALUES (?, ?, ?, ?, ?)`,
      [actor, action, target, details, chainHash],
      (err) => {
        if (err) console.error('[ActivityLog] Append error:', err.message);
      }
    );
  }

  /**
   * Verify the integrity of the hash chain.
   * Walks every entry and confirms each hash links to the previous.
   *
   * Returns: { valid: boolean, entries: number, brokenAt?: number, details?: string }
   */
  async verify() {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT id, actor, action, target, details, chain_hash FROM activity_log ORDER BY id ASC',
        [],
        (err, rows) => {
          if (err) return reject(err);
          if (!rows || rows.length === 0) {
            return resolve({ valid: true, entries: 0 });
          }

          let previousHash = null;
          for (const row of rows) {
            // Skip entries without chain_hash (pre-upgrade entries)
            if (!row.chain_hash) continue;

            const entryData = `${row.actor}|${row.action}|${row.target || ''}|${row.details || ''}`;
            const expectedHash = this._computeChainHash(previousHash, entryData);

            if (row.chain_hash !== expectedHash) {
              return resolve({
                valid: false,
                entries: rows.length,
                brokenAt: row.id,
                details: `Hash chain broken at entry ${row.id} (${row.action}). Expected ${expectedHash.substring(0, 16)}..., got ${row.chain_hash.substring(0, 16)}...`,
              });
            }

            previousHash = row.chain_hash;
          }

          resolve({ valid: true, entries: rows.length });
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
        `SELECT actor, action, COUNT(*) as count
         FROM activity_log
         WHERE DATE(created_at) = ?
         GROUP BY actor, action
         ORDER BY count DESC`,
        [targetDate],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }
}

module.exports = { ActivityLog };
