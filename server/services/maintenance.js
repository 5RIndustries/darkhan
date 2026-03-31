/**
 * Darkhan — Maintenance Service
 *
 * Handles startup cleanup, periodic hygiene, and orphan process detection.
 * Runs on server start and then on a daily schedule.
 *
 * Problems this solves:
 * - Orphan processes surviving after crashes/freezes (no graceful shutdown)
 * - Stale heartbeat entries from agents that disappeared
 * - Database bloat from old sessions and activity logs
 * - Dead workers that crashed but were never restarted
 *
 * Created: 2026-03-31
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PID_FILE = path.join(__dirname, '..', '.darkhan.pid');
const STALE_HEARTBEAT_MS = 24 * 60 * 60 * 1000;  // 24 hours
const OLD_SESSION_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
const OLD_ACTIVITY_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const DAILY_MS = 24 * 60 * 60 * 1000;

class MaintenanceService {
  constructor({ db, activityLog, workerRuntime }) {
    this.db = db;
    this.activityLog = activityLog;
    this.workerRuntime = workerRuntime;
    this._dailyInterval = null;
  }

  /**
   * Run on server startup — clean up anything left over from previous runs.
   */
  async startup() {
    console.log('[Maintenance] Running startup cleanup...');
    const results = {
      orphansCleaned: 0,
      staleHeartbeats: 0,
      staleSessions: 0,
    };

    // 1. PID file — detect and clean up previous instance
    results.orphansCleaned = this._cleanOrphanProcesses();

    // 2. Write our own PID file
    this._writePidFile();

    // 3. Purge stale heartbeats
    results.staleHeartbeats = await this._purgeStaleHeartbeats();

    // 4. Clean expired sessions
    results.staleSessions = await this._cleanExpiredSessions();

    // 5. Log what we did
    const cleaned = results.orphansCleaned + results.staleHeartbeats + results.staleSessions;
    if (cleaned > 0) {
      console.log(`[Maintenance] Startup cleanup: ${results.orphansCleaned} orphan(s), ${results.staleHeartbeats} stale heartbeat(s), ${results.staleSessions} expired session(s)`);
      this.activityLog.append({
        actor: 'system',
        action: 'maintenance_startup',
        details: JSON.stringify(results),
      });
    } else {
      console.log('[Maintenance] Startup cleanup: nothing to clean');
    }

    return results;
  }

  /**
   * Start daily maintenance schedule.
   */
  startSchedule() {
    // Run daily maintenance at 0300 ET (between Corey audit at 0100 and morning brief at 0600)
    this._dailyInterval = setInterval(() => {
      this.runDaily();
    }, DAILY_MS);

    // Also run 1 hour after startup to catch anything the startup pass missed
    setTimeout(() => this.runDaily(), 60 * 60 * 1000);
  }

  /**
   * Full daily maintenance pass.
   */
  async runDaily() {
    console.log('[Maintenance] Running daily maintenance...');
    const results = {};

    try {
      // 1. Purge stale heartbeats
      results.staleHeartbeats = await this._purgeStaleHeartbeats();

      // 2. Clean expired sessions
      results.staleSessions = await this._cleanExpiredSessions();

      // 3. Activity log is immutable (hash chain + SQLite triggers prevent deletion).
      // Do NOT trim. If space is a concern, archive externally.

      // 4. Database VACUUM (reclaim space)
      results.vacuumed = await this._vacuumDatabase();

      // 5. Check for dead workers and report
      results.deadWorkers = this._detectDeadWorkers();

      // 6. Clean up temp files
      results.tempFiles = this._cleanTempFiles();

      console.log('[Maintenance] Daily maintenance complete:', JSON.stringify(results));
      this.activityLog.append({
        actor: 'system',
        action: 'maintenance_daily',
        details: JSON.stringify(results),
      });
    } catch (err) {
      console.error('[Maintenance] Daily maintenance error:', err.message);
    }

    return results;
  }

  /**
   * Detect orphan processes from a previous Darkhan instance that didn't shut down cleanly.
   * Uses PID file + process table scanning.
   */
  _cleanOrphanProcesses() {
    let cleaned = 0;

    // Check PID file from previous run
    try {
      if (fs.existsSync(PID_FILE)) {
        const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (oldPid && oldPid !== process.pid) {
          // Check if old process is still running
          try {
            process.kill(oldPid, 0); // Signal 0 = existence check
            console.warn(`[Maintenance] Previous Darkhan instance (PID ${oldPid}) still running — this may cause port conflicts`);
            // Don't kill it — could be intentional. Just warn.
          } catch (e) {
            // Process is gone — clean exit or crash. Either way, PID file is stale.
            console.log(`[Maintenance] Previous instance (PID ${oldPid}) is gone — cleaning up PID file`);
          }
        }
        fs.unlinkSync(PID_FILE);
      }
    } catch (e) {
      // PID file operations are best-effort
    }

    // Scan for orphan child processes that match Darkhan worker patterns
    // [L-3 FIX] Use `ps -eo pid,ppid,command` for reliable PID/PPID parsing
    // (ps aux does not include PPID column)
    try {
      const output = execSync('ps -eo pid,ppid,command', { encoding: 'utf8', timeout: 5000 });
      const lines = output.split('\n');
      const orphans = [];

      for (const line of lines) {
        if (line.includes('worker-process.js') && !line.includes(String(process.pid))) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[0], 10);
          const ppid = parseInt(parts[1], 10);
          // If parent PID is 1 (adopted by init/launchd), it's an orphan
          if (ppid === 1 && pid !== process.pid) {
            orphans.push(pid);
          }
        }
      }

      for (const pid of orphans) {
        try {
          process.kill(pid, 'SIGTERM');
          cleaned++;
          console.log(`[Maintenance] Killed orphan worker process (PID ${pid})`);
        } catch (e) {
          // Already gone
        }
      }
    } catch (e) {
      // ps command failed — non-fatal
    }

    return cleaned;
  }

  /**
   * Write current PID to file for next-startup orphan detection.
   */
  _writePidFile() {
    try {
      fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    } catch (e) {
      console.warn('[Maintenance] Could not write PID file:', e.message);
    }
  }

  /**
   * Remove heartbeat entries for agents not seen in 24+ hours.
   */
  _purgeStaleHeartbeats() {
    return new Promise((resolve) => {
      const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS).toISOString();
      this.db.run(
        `UPDATE agent_heartbeats SET status = 'down' WHERE last_ping_at < ? AND status != 'down'`,
        [cutoff],
        function (err) {
          if (err) {
            console.error('[Maintenance] Heartbeat purge error:', err.message);
            resolve(0);
          } else {
            resolve(this.changes || 0);
          }
        }
      );
    });
  }

  /**
   * Delete sessions older than 7 days.
   */
  _cleanExpiredSessions() {
    return new Promise((resolve) => {
      const cutoff = new Date(Date.now() - OLD_SESSION_MS).toISOString();
      this.db.run(
        'DELETE FROM sessions WHERE expires < ?',
        [cutoff],
        function (err) {
          if (err) {
            // Table might not exist or different schema — non-fatal
            resolve(0);
          } else {
            resolve(this.changes || 0);
          }
        }
      );
    });
  }

  /**
   * Trim activity log entries older than 30 days.
   * Keeps the database from growing unbounded.
   */
  _trimActivityLog() {
    return new Promise((resolve) => {
      const cutoff = new Date(Date.now() - OLD_ACTIVITY_MS).toISOString();
      this.db.run(
        'DELETE FROM activity_log WHERE timestamp < ?',
        [cutoff],
        function (err) {
          if (err) {
            resolve(0);
          } else {
            resolve(this.changes || 0);
          }
        }
      );
    });
  }

  /**
   * VACUUM the database to reclaim disk space.
   */
  _vacuumDatabase() {
    return new Promise((resolve) => {
      this.db.run('VACUUM', (err) => {
        if (err) {
          console.error('[Maintenance] VACUUM error:', err.message);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Check WorkerRuntime for dead workers and report them.
   * Does NOT auto-restart — that's a separate decision (logged for admin review).
   */
  _detectDeadWorkers() {
    const dead = [];
    if (!this.workerRuntime) return dead;

    for (const [id, worker] of this.workerRuntime.workers || new Map()) {
      if (worker.status === 'dead') {
        dead.push(id);
        console.warn(`[Maintenance] Dead worker detected: ${id}`);
      }
    }

    return dead;
  }

  /**
   * Clean up stale temp files from sandbox and other sources.
   */
  _cleanTempFiles() {
    let cleaned = 0;
    const tmpDir = '/tmp/darkhan-sandbox';
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    try {
      if (fs.existsSync(tmpDir)) {
        const entries = fs.readdirSync(tmpDir);
        for (const entry of entries) {
          const entryPath = path.join(tmpDir, entry);
          try {
            const stat = fs.statSync(entryPath);
            if (stat.mtimeMs < oneHourAgo) {
              fs.rmSync(entryPath, { recursive: true, force: true });
              cleaned++;
            }
          } catch (e) { /* skip individual errors */ }
        }
      }
    } catch (e) { /* temp dir doesn't exist — fine */ }

    return cleaned;
  }

  /**
   * Clean shutdown — remove PID file.
   */
  shutdown() {
    if (this._dailyInterval) {
      clearInterval(this._dailyInterval);
      this._dailyInterval = null;
    }
    try {
      if (fs.existsSync(PID_FILE)) {
        fs.unlinkSync(PID_FILE);
      }
    } catch (e) { /* best effort */ }
    console.log('[Maintenance] Shutdown complete');
  }
}

module.exports = { MaintenanceService };
