/**
 * Darkhan — Rate Limiter
 *
 * Per-agent and per-provider rate limiting with intelligent queuing.
 * Prevents 429 storms by budgeting API calls across the day.
 *
 * Two levels:
 *   1. Provider-level: global limit shared across all agents using that provider
 *   2. Agent-level: per-agent daily budget (subset of provider limit)
 *
 * 0 = unlimited (used for local models like Ollama)
 */

class RateLimiter {
  constructor({ config, activityLog }) {
    this.activityLog = activityLog;

    // Load global provider limits from config
    this.providerLimits = {};
    const globalLimits = config.llm?.globalRateLimits || {};
    for (const [provider, limits] of Object.entries(globalLimits)) {
      this.providerLimits[provider] = {
        perDay: limits.requestsPerDay || 0,
        perMinute: limits.requestsPerMinute || 0,
      };
    }

    // Load per-agent limits from config
    this.agentLimits = {};
    const members = config.team?.members || [];
    for (const member of members) {
      if (member.rateLimits) {
        this.agentLimits[member.id] = {
          perDay: member.rateLimits.requestsPerDay || 0,
          perMinute: member.rateLimits.requestsPerMinute || 0,
        };
      }
    }

    // Usage tracking (resets daily at midnight ET)
    this.providerUsage = {};  // { provider: { today: count, minuteBucket: count, minuteStart: timestamp } }
    this.agentUsage = {};     // { agentId: { today: count, lastReset: date } }

    // Schedule daily reset at midnight ET
    this._scheduleDailyReset();

    console.log('[RateLimiter] Initialized:', {
      providers: Object.keys(this.providerLimits),
      agents: Object.keys(this.agentLimits),
    });
  }

  /**
   * Check if a request is allowed. Throws if over limit.
   */
  async check(agentId, provider) {
    const now = Date.now();

    // Check provider per-minute limit
    const providerLimit = this.providerLimits[provider];
    if (providerLimit && providerLimit.perMinute > 0) {
      const usage = this._getProviderUsage(provider);
      const minuteAge = now - usage.minuteStart;

      if (minuteAge > 60000) {
        // Reset minute bucket
        usage.minuteBucket = 0;
        usage.minuteStart = now;
      } else if (usage.minuteBucket >= providerLimit.perMinute) {
        const waitMs = 60000 - minuteAge;
        const err = new Error(
          `Rate limit: ${provider} at ${usage.minuteBucket}/${providerLimit.perMinute} RPM. Retry in ${Math.ceil(waitMs / 1000)}s.`
        );
        err.name = 'RateLimitError';
        err.retryable = true;
        err.retryAfterMs = waitMs;
        throw err;
      }
    }

    // Check provider per-day limit
    if (providerLimit && providerLimit.perDay > 0) {
      const usage = this._getProviderUsage(provider);
      if (usage.today >= providerLimit.perDay) {
        const err = new Error(
          `Daily limit: ${provider} at ${usage.today}/${providerLimit.perDay} RPD. Resets at midnight ET.`
        );
        err.name = 'BudgetExceededError';
        err.retryable = false;
        throw err;
      }
    }

    // Check agent per-day limit
    const agentLimit = this.agentLimits[agentId];
    if (agentLimit && agentLimit.perDay > 0) {
      const usage = this._getAgentUsage(agentId);
      if (usage.today >= agentLimit.perDay) {
        const err = new Error(
          `Agent budget: ${agentId} at ${usage.today}/${agentLimit.perDay} RPD.`
        );
        err.name = 'BudgetExceededError';
        err.retryable = false;
        throw err;
      }
    }
  }

  /**
   * Record a successful request.
   */
  record(agentId, provider) {
    const providerUsage = this._getProviderUsage(provider);
    providerUsage.today++;
    providerUsage.minuteBucket++;

    const agentUsage = this._getAgentUsage(agentId);
    agentUsage.today++;
  }

  /**
   * Get current usage summary for dashboard.
   */
  getSummary() {
    const summary = {
      providers: {},
      agents: {},
    };

    for (const [provider, limits] of Object.entries(this.providerLimits)) {
      const usage = this._getProviderUsage(provider);
      summary.providers[provider] = {
        used: usage.today,
        limit: limits.perDay,
        remaining: limits.perDay > 0 ? limits.perDay - usage.today : 'unlimited',
        perMinute: { used: usage.minuteBucket, limit: limits.perMinute },
      };
    }

    for (const [agentId, limits] of Object.entries(this.agentLimits)) {
      const usage = this._getAgentUsage(agentId);
      summary.agents[agentId] = {
        used: usage.today,
        limit: limits.perDay,
        remaining: limits.perDay > 0 ? limits.perDay - usage.today : 'unlimited',
      };
    }

    return summary;
  }

  // --- Internal ---

  _getProviderUsage(provider) {
    if (!this.providerUsage[provider]) {
      this.providerUsage[provider] = { today: 0, minuteBucket: 0, minuteStart: Date.now() };
    }
    return this.providerUsage[provider];
  }

  _getAgentUsage(agentId) {
    const today = new Date().toISOString().substring(0, 10);
    if (!this.agentUsage[agentId] || this.agentUsage[agentId].lastReset !== today) {
      this.agentUsage[agentId] = { today: 0, lastReset: today };
    }
    return this.agentUsage[agentId];
  }

  _scheduleDailyReset() {
    // Reset at midnight ET
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const tomorrow = new Date(et);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - et.getTime();

    setTimeout(() => {
      this._resetDaily();
      // Then reset every 24h
      setInterval(() => this._resetDaily(), 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }

  _resetDaily() {
    console.log('[RateLimiter] Daily reset');
    for (const provider of Object.keys(this.providerUsage)) {
      this.providerUsage[provider].today = 0;
    }
    for (const agentId of Object.keys(this.agentUsage)) {
      this.agentUsage[agentId].today = 0;
      this.agentUsage[agentId].lastReset = new Date().toISOString().substring(0, 10);
    }

    if (this.activityLog) {
      this.activityLog.append({
        actor: 'system',
        action: 'rate_limit_reset',
        target: 'all',
        details: JSON.stringify({ timestamp: new Date().toISOString() }),
      });
    }
  }
}

module.exports = { RateLimiter };
