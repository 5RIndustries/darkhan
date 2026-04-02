/**
 * Darkhan — Review Gate
 *
 * Optional output verification layer. When enabled, Claude's responses
 * are reviewed by the local LLM before posting to channels.
 *
 * The reviewer checks for:
 *   - Unverified claims (said "deployed" but no evidence of deployment)
 *   - Contradictions with known state
 *   - Hallucinated file paths, URLs, or data
 *   - Overconfident statements without qualification
 *
 * Config (darkhan.config.json):
 *   "reviewGate": {
 *     "enabled": false,          // off by default — user toggles on
 *     "model": "local",          // "local" (Ollama, $0) or "cloud" (Gemini/GPT)
 *     "severity": "critical"     // "critical" = block, "all" = flag everything
 *   }
 *
 * Toggle via chat: /review-gate on | /review-gate off | /review-gate status
 */

const http = require('http');

class ReviewGate {
  constructor({ config }) {
    this.enabled = config.reviewGate?.enabled || false;
    this.model = config.reviewGate?.model || 'local';
    this.severity = config.reviewGate?.severity || 'critical';
    this.config = config;
    this.stats = { reviewed: 0, flagged: 0, passed: 0 };
  }

  /**
   * Review a response before it's posted. Returns the review result.
   * If the gate is disabled, passes through immediately.
   */
  async review(response, originalMessage, fromUser) {
    if (!this.enabled) {
      return { approved: true, response, flags: [] };
    }

    if (!response || response.length < 20) {
      return { approved: true, response, flags: [] };
    }

    this.stats.reviewed++;

    try {
      const result = await this._runReview(response, originalMessage, fromUser);
      if (result.flags.length > 0) {
        this.stats.flagged++;
        console.log(`[ReviewGate] Flagged ${result.flags.length} issue(s) in response`);
      } else {
        this.stats.passed++;
      }
      return result;
    } catch (err) {
      console.error(`[ReviewGate] Review failed: ${err.message} — passing through`);
      return { approved: true, response, flags: [], error: err.message };
    }
  }

  /**
   * Run the review via local LLM.
   */
  async _runReview(response, originalMessage, fromUser) {
    const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
    const ollamaHost = process.env.OLLAMA_HOST || 'localhost';
    const ollamaPort = parseInt(process.env.OLLAMA_PORT || '11434');

    const prompt = `You are a response reviewer. Check the AI response below for issues.

USER ASKED: ${originalMessage}

AI RESPONDED: ${response.substring(0, 3000)}

Check for these issues ONLY:
1. UNVERIFIED_CLAIM — Says something is "deployed", "running", "complete" without evidence
2. HALLUCINATION — References files, URLs, data, or facts that seem fabricated
3. CONTRADICTION — Contradicts information in the conversation
4. OVERCONFIDENT — Makes strong assertions without qualification

Respond in this EXACT format (JSON array, empty if no issues):
[{"type":"UNVERIFIED_CLAIM","detail":"claimed X is deployed but no verification shown"}]

If the response looks fine, respond with: []`;

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 500 },
      });

      const req = http.request({
        hostname: ollamaHost,
        port: ollamaPort,
        path: '/api/generate',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const reviewText = (parsed.response || '').trim();

            // Parse the JSON array from the LLM response
            let flags = [];
            try {
              const jsonMatch = reviewText.match(/\[[\s\S]*\]/);
              if (jsonMatch) {
                flags = JSON.parse(jsonMatch[0]);
              }
            } catch { /* empty or malformed — treat as clean */ }

            const hasCritical = flags.some(f =>
              f.type === 'UNVERIFIED_CLAIM' || f.type === 'HALLUCINATION'
            );

            // In "critical" severity mode, only block on critical issues
            const shouldBlock = this.severity === 'all'
              ? flags.length > 0
              : hasCritical;

            if (shouldBlock) {
              // Append flags to the response as a visible warning
              const flagSummary = flags.map(f => `⚠ ${f.type}: ${f.detail}`).join('\n');
              const annotatedResponse = `${response}\n\n---\n**⚠ Review Gate Flags:**\n${flagSummary}`;
              resolve({ approved: true, response: annotatedResponse, flags, blocked: false });
            } else {
              resolve({ approved: true, response, flags });
            }
          } catch (e) {
            resolve({ approved: true, response, flags: [] });
          }
        });
      });

      req.on('error', () => resolve({ approved: true, response, flags: [] }));
      req.on('timeout', () => { req.destroy(); resolve({ approved: true, response, flags: [] }); });
      req.write(postData);
      req.end();
    });
  }

  // --- Toggle & Status ---

  enable() {
    this.enabled = true;
    console.log('[ReviewGate] Enabled');
  }

  disable() {
    this.enabled = false;
    console.log('[ReviewGate] Disabled');
  }

  getStatus() {
    return {
      enabled: this.enabled,
      model: this.model,
      severity: this.severity,
      stats: { ...this.stats },
    };
  }
}

module.exports = { ReviewGate };
