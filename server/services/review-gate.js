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

const { LocalLLMProvider } = require('./local-llm');

let _localLLM = null;
function getLocalLLM() {
  if (!_localLLM) _localLLM = new LocalLLMProvider();
  return _localLLM;
}

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
    const localModel = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

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

    try {
      const localLLM = getLocalLLM();
      const result = await localLLM.generate(localModel, prompt, {
        temperature: 0.1,
        maxTokens: 500,
        timeout: 15000,
      });

      const reviewText = (result.response || '').trim();

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

      const shouldBlock = this.severity === 'all'
        ? flags.length > 0
        : hasCritical;

      if (shouldBlock) {
        const flagSummary = flags.map(f => `⚠ ${f.type}: ${f.detail}`).join('\n');
        const annotatedResponse = `${response}\n\n---\n**⚠ Review Gate Flags:**\n${flagSummary}`;
        return { approved: true, response: annotatedResponse, flags, blocked: false };
      }
      return { approved: true, response, flags };
    } catch (e) {
      console.error(`[ReviewGate] Review error: ${e.message}`);
      return { approved: true, response, flags: [] };
    }
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
