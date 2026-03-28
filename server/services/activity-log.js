/**
 * Darkhan — Immutable Activity Log
 *
 * Append-only event log for all agent and human actions.
 * NO DELETE, NO UPDATE — audit trail only.
 */

class ActivityLog {
  constructor({ db }) {
    this.db = db;
    this._ensureTable();
  }

  _ensureTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

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
   * Append an event to the activity log.
   * This is the ONLY write method. No update, no delete.
   */
  append({ actor, action, target = null, details = null }) {
    this.db.run(
      `INSERT INTO activity_log (actor, action, target, details) VALUES (?, ?, ?, ?)`,
      [actor, action, target, details],
      (err) => {
        if (err) console.error('[ActivityLog] Append error:', err.message);
      }
    );
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
