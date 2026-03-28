/**
 * Darkhan — Cost Tracker
 *
 * Per-agent token and cost accounting. Append-only tracking table.
 * Uses INTEGER millicents (not REAL) per Corey's recommendation.
 */

class CostTracker {
  constructor({ db }) {
    this.db = db;
    this._ensureTable();
  }

  _ensureTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cost_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost_millicents INTEGER DEFAULT 0,
        request_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Index for daily summaries
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_cost_agent_date
      ON cost_tracking (agent, created_at)
    `);
  }

  /**
   * Record an LLM call's cost.
   */
  async record({ agent, provider, model, tokensIn, tokensOut, costMillicents, requestType }) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO cost_tracking (agent, provider, model, tokens_in, tokens_out, cost_millicents, request_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [agent, provider, model, tokensIn || 0, tokensOut || 0, costMillicents || 0, requestType || 'unknown'],
        function (err) {
          if (err) {
            console.error('[CostTracker] Record error:', err.message);
            reject(err);
          } else {
            resolve({ id: this.lastID });
          }
        }
      );
    });
  }

  /**
   * Get daily summary per agent.
   */
  async getDailySummary(date) {
    const targetDate = date || new Date().toISOString().substring(0, 10);
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT
          agent,
          provider,
          model,
          COUNT(*) as request_count,
          SUM(tokens_in) as total_tokens_in,
          SUM(tokens_out) as total_tokens_out,
          SUM(cost_millicents) as total_cost_millicents
        FROM cost_tracking
        WHERE DATE(created_at) = ?
        GROUP BY agent, provider, model
        ORDER BY total_cost_millicents DESC`,
        [targetDate],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  /**
   * Get total cost for an agent today.
   */
  async getAgentDailyCost(agentId) {
    const today = new Date().toISOString().substring(0, 10);
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT
          COUNT(*) as requests,
          SUM(tokens_in) as tokens_in,
          SUM(tokens_out) as tokens_out,
          SUM(cost_millicents) as cost_millicents
        FROM cost_tracking
        WHERE agent = ? AND DATE(created_at) = ?`,
        [agentId, today],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || { requests: 0, tokens_in: 0, tokens_out: 0, cost_millicents: 0 });
        }
      );
    });
  }

  /**
   * Get all-time summary.
   */
  async getTotalSummary() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT
          agent,
          COUNT(*) as total_requests,
          SUM(tokens_in) as total_tokens_in,
          SUM(tokens_out) as total_tokens_out,
          SUM(cost_millicents) as total_cost_millicents
        FROM cost_tracking
        GROUP BY agent
        ORDER BY total_cost_millicents DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }
}

module.exports = { CostTracker };
