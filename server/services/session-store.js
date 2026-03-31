/**
 * SQLite Session Store for express-session
 *
 * Replaces connect-sqlite3 (which bundles sqlite3@5.x with known vulnerabilities)
 * by using the project's own sqlite3@6.x installation directly.
 *
 * Written 2026-03-31 after dependency audit revealed connect-sqlite3 was the sole
 * source of 7 remaining npm vulnerabilities (tar path traversal chain).
 */

const sqlite3 = require('sqlite3');
const path = require('path');

module.exports = function (session) {
  const Store = session.Store;

  class SQLiteSessionStore extends Store {
    constructor(options = {}) {
      super(options);
      const table = options.table || 'sessions';
      // [H-1 FIX] Validate table name to prevent SQL injection via configuration
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        throw new Error(`Invalid session table name: ${table}`);
      }
      const dbFile = options.db || 'sessions.db';
      const dir = options.dir || '.';
      const dbPath = path.join(dir, dbFile);

      this.table = table;
      this.db = new sqlite3.Database(dbPath);

      // WAL mode for concurrent access, create table if needed
      this.db.exec(
        `PRAGMA journal_mode = wal; CREATE TABLE IF NOT EXISTS ${table} (sid TEXT PRIMARY KEY, expired INTEGER, sess TEXT)`,
        (err) => { if (err) throw err; }
      );

      // Clean expired sessions every 15 minutes
      this._cleanupInterval = setInterval(() => {
        this.db.run(`DELETE FROM ${this.table} WHERE ? > expired`, [Date.now()]);
      }, 15 * 60 * 1000);
    }

    get(sid, callback) {
      this.db.get(
        `SELECT sess FROM ${this.table} WHERE sid = ? AND ? <= expired`,
        [sid, Date.now()],
        (err, row) => {
          if (err) return callback(err);
          if (!row) return callback(null, null);
          try {
            callback(null, JSON.parse(row.sess));
          } catch (e) {
            callback(e);
          }
        }
      );
    }

    set(sid, session, callback) {
      const maxAge = session.cookie && session.cookie.maxAge
        ? session.cookie.maxAge
        : 86400000; // 1 day default
      const expired = Date.now() + maxAge;
      const sess = JSON.stringify(session);

      this.db.run(
        `INSERT OR REPLACE INTO ${this.table} (sid, expired, sess) VALUES (?, ?, ?)`,
        [sid, expired, sess],
        (err) => callback(err)
      );
    }

    destroy(sid, callback) {
      this.db.run(
        `DELETE FROM ${this.table} WHERE sid = ?`,
        [sid],
        (err) => callback(err)
      );
    }

    length(callback) {
      this.db.get(
        `SELECT COUNT(*) AS count FROM ${this.table} WHERE ? <= expired`,
        [Date.now()],
        (err, row) => callback(err, row ? row.count : 0)
      );
    }

    clear(callback) {
      this.db.run(`DELETE FROM ${this.table}`, (err) => callback(err));
    }

    touch(sid, session, callback) {
      const maxAge = session.cookie && session.cookie.maxAge
        ? session.cookie.maxAge
        : 86400000;
      const expired = Date.now() + maxAge;

      this.db.run(
        `UPDATE ${this.table} SET expired = ? WHERE sid = ?`,
        [expired, sid],
        (err) => callback(err)
      );
    }

    close() {
      clearInterval(this._cleanupInterval);
      this.db.close();
    }
  }

  return SQLiteSessionStore;
};
