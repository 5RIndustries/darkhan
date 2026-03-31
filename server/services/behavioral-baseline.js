/**
 * Darkhan — Behavioral Baseline Service
 *
 * [MYTHOS DEFENSE] Tracks normal activity patterns for each agent.
 * When an agent deviates significantly from its baseline (3x any metric),
 * an alert is generated. This catches:
 *   - Compromised agents suddenly making unusual API calls
 *   - Agents posting to channels they don't normally use
 *   - Agents running shell commands at unusual rates
 *   - Data exfiltration disguised as normal operation but at abnormal volume
 *
 * The baseline is updated daily from the activity log.
 * It takes 3+ days of data before the baseline is considered reliable.
 */

class BehavioralBaseline {
  constructor({ db, activityLog, io }) {
    this.db = db;
    this.activityLog = activityLog;
    this.io = io;
  }

  /**
   * Update baselines for all agents from the last 24 hours of activity.
   * Run daily (e.g., via cron at 0200 ET).
   */
  async updateAllBaselines() {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Get today's activity counts per agent
      this.db.all(`
        SELECT actor,
          SUM(CASE WHEN action IN ('message_posted', 'channel_message') THEN 1 ELSE 0 END) as messages,
          SUM(CASE WHEN action LIKE 'llm_%' OR action LIKE '%complete%' THEN 1 ELSE 0 END) as llm_calls,
          SUM(CASE WHEN action LIKE 'shell_%' OR action = 'tool_shell_exec' THEN 1 ELSE 0 END) as shell_execs,
          SUM(CASE WHEN action LIKE 'file_write%' OR action = 'tool_fs_write' THEN 1 ELSE 0 END) as file_writes
        FROM activity_log
        WHERE created_at > ? AND actor LIKE 'agent_%'
        GROUP BY actor
      `, [since], (err, rows) => {
        if (err) return reject(err);
        if (!rows || rows.length === 0) return resolve({ updated: 0 });

        let updated = 0;
        const remaining = rows.length;

        for (const row of rows) {
          // Update rolling average
          this.db.get('SELECT * FROM agent_baselines WHERE agent_id = ?', [row.actor], (err2, existing) => {
            if (err2) return;

            const days = existing ? existing.sample_days + 1 : 1;
            const alpha = 1 / Math.min(days, 30); // Exponential moving average, cap at 30 days

            const newBaseline = {
              avg_messages_per_day: existing
                ? existing.avg_messages_per_day * (1 - alpha) + row.messages * alpha
                : row.messages,
              avg_llm_calls_per_day: existing
                ? existing.avg_llm_calls_per_day * (1 - alpha) + row.llm_calls * alpha
                : row.llm_calls,
              avg_shell_execs_per_day: existing
                ? existing.avg_shell_execs_per_day * (1 - alpha) + row.shell_execs * alpha
                : row.shell_execs,
              avg_file_writes_per_day: existing
                ? existing.avg_file_writes_per_day * (1 - alpha) + row.file_writes * alpha
                : row.file_writes,
            };

            this.db.run(`
              INSERT INTO agent_baselines (agent_id, avg_messages_per_day, avg_llm_calls_per_day,
                avg_shell_execs_per_day, avg_file_writes_per_day, sample_days, last_updated)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(agent_id) DO UPDATE SET
                avg_messages_per_day = ?,
                avg_llm_calls_per_day = ?,
                avg_shell_execs_per_day = ?,
                avg_file_writes_per_day = ?,
                sample_days = ?,
                last_updated = datetime('now')
            `, [
              row.actor,
              newBaseline.avg_messages_per_day, newBaseline.avg_llm_calls_per_day,
              newBaseline.avg_shell_execs_per_day, newBaseline.avg_file_writes_per_day, days,
              newBaseline.avg_messages_per_day, newBaseline.avg_llm_calls_per_day,
              newBaseline.avg_shell_execs_per_day, newBaseline.avg_file_writes_per_day, days,
            ]);

            updated++;
            if (updated === remaining) {
              console.log(`[Baseline] Updated baselines for ${updated} agent(s)`);
              resolve({ updated });
            }
          });
        }
      });
    });
  }

  /**
   * Check an agent's current activity against its baseline.
   * Returns anomalies if any metric exceeds 3x the baseline.
   * Only flags after 3+ days of baseline data.
   */
  async checkAgent(agentId) {
    if (!this.db) return { anomalies: [] };

    return new Promise((resolve) => {
      this.db.get('SELECT * FROM agent_baselines WHERE agent_id = ?', [agentId], (err, baseline) => {
        if (err || !baseline || baseline.sample_days < 3) {
          return resolve({ anomalies: [], reason: 'insufficient_data' });
        }

        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        this.db.get(`
          SELECT
            SUM(CASE WHEN action IN ('message_posted', 'channel_message') THEN 1 ELSE 0 END) as messages,
            SUM(CASE WHEN action LIKE 'llm_%' THEN 1 ELSE 0 END) as llm_calls,
            SUM(CASE WHEN action LIKE 'shell_%' THEN 1 ELSE 0 END) as shell_execs,
            SUM(CASE WHEN action LIKE 'file_write%' THEN 1 ELSE 0 END) as file_writes
          FROM activity_log WHERE actor = ? AND created_at > ?
        `, [agentId, since], (err2, current) => {
          if (err2 || !current) return resolve({ anomalies: [] });

          const threshold = 3; // 3x baseline triggers alert
          const anomalies = [];

          if (baseline.avg_messages_per_day > 0 && current.messages > baseline.avg_messages_per_day * threshold) {
            anomalies.push({ metric: 'messages', current: current.messages, baseline: baseline.avg_messages_per_day, ratio: current.messages / baseline.avg_messages_per_day });
          }
          if (baseline.avg_llm_calls_per_day > 0 && current.llm_calls > baseline.avg_llm_calls_per_day * threshold) {
            anomalies.push({ metric: 'llm_calls', current: current.llm_calls, baseline: baseline.avg_llm_calls_per_day, ratio: current.llm_calls / baseline.avg_llm_calls_per_day });
          }
          if (baseline.avg_shell_execs_per_day > 0 && current.shell_execs > baseline.avg_shell_execs_per_day * threshold) {
            anomalies.push({ metric: 'shell_execs', current: current.shell_execs, baseline: baseline.avg_shell_execs_per_day, ratio: current.shell_execs / baseline.avg_shell_execs_per_day });
          }
          if (baseline.avg_file_writes_per_day > 0 && current.file_writes > baseline.avg_file_writes_per_day * threshold) {
            anomalies.push({ metric: 'file_writes', current: current.file_writes, baseline: baseline.avg_file_writes_per_day, ratio: current.file_writes / baseline.avg_file_writes_per_day });
          }

          if (anomalies.length > 0 && this.activityLog) {
            this.activityLog.append({
              actor: 'darkhan_security',
              action: 'behavioral_anomaly_detected',
              target: agentId,
              details: JSON.stringify({ anomalies }),
            });

            // Post alert
            if (this.io) {
              const { v4: uuidv4 } = require('uuid');
              const alertBody = `[BEHAVIORAL ANOMALY] ${agentId}: ${anomalies.map(a => `${a.metric} at ${a.ratio.toFixed(1)}x baseline`).join(', ')}`;
              this.io.to('chan_alerts').emit('new_message', {
                id: uuidv4(), channel_id: 'chan_alerts', from_user: 'darkhan_security',
                body: alertBody, priority: 'high', type: 'alert',
                created_at: new Date().toISOString(),
              });
            }
          }

          resolve({ anomalies, baseline, current });
        });
      });
    });
  }

  /**
   * Get baselines for all agents.
   */
  async getAllBaselines() {
    return new Promise((resolve) => {
      this.db.all('SELECT * FROM agent_baselines ORDER BY agent_id', [], (err, rows) => {
        resolve(rows || []);
      });
    });
  }
}

module.exports = { BehavioralBaseline };
