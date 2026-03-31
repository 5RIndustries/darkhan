/**
 * Darkhan — Unified LLM Interface
 *
 * Single interface for all LLM calls: Ollama, Google Gemini, Anthropic Claude.
 * Rate limiting and cost tracking integrated.
 */

const http = require('http');
const https = require('https');

class LLMService {
  constructor({ rateLimiter, costTracker, activityLog, config }) {
    this.rateLimiter = rateLimiter;
    this.costTracker = costTracker;
    this.activityLog = activityLog;
    this.config = config;
    this.providers = config.llm.providers;
  }

  /**
   * Main completion method — routes to the correct provider.
   *
   * @param {Object} opts
   * @param {string} opts.agentId - Agent making the request (for rate limiting + cost tracking)
   * @param {string} opts.provider - 'ollama', 'google', or 'anthropic'
   * @param {string} opts.model - Model ID (e.g., 'qwen2.5:14b', 'gemini-2.5-pro')
   * @param {Array} opts.messages - [{ role: 'user'|'assistant'|'system', content: string }]
   * @param {Object} opts.options - Provider-specific options (temperature, maxTokens, etc.)
   * @param {string} opts.requestType - For cost tracking ('triage', 'task', 'subagent', etc.)
   * @returns {{ response: string, usage: { inputTokens: number, outputTokens: number, costMillicents: number } }}
   */
  async complete({ agentId, provider, model, messages, options = {}, requestType = 'task' }) {
    // Check rate limits
    await this.rateLimiter.check(agentId, provider);

    const startTime = Date.now();
    let result;

    switch (provider) {
      case 'ollama':
        result = await this._ollamaComplete(model, messages, options);
        break;
      case 'google':
        result = await this._geminiComplete(model, messages, options);
        break;
      case 'anthropic':
        result = await this._anthropicComplete(model, messages, options);
        break;
      default:
        throw new Error(`Unknown LLM provider: ${provider}`);
    }

    const elapsed = Date.now() - startTime;

    // Record usage
    this.rateLimiter.record(agentId, provider);

    // Track cost
    const costMillicents = this._estimateCost(provider, model, result.usage);
    await this.costTracker.record({
      agent: agentId,
      provider,
      model,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      costMillicents,
      requestType,
    });

    // Model version tag — includes digest for local models (traceability)
    const modelTag = {
      provider,
      model,
      digest: result.modelDigest || null,
    };

    // Activity log
    this.activityLog.append({
      actor: agentId,
      action: 'llm_call',
      target: `${provider}/${model}`,
      details: JSON.stringify({
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        costMillicents,
        elapsedMs: elapsed,
        requestType,
        modelDigest: result.modelDigest || null,
      }),
    });

    return {
      response: result.response,
      usage: { ...result.usage, costMillicents },
      modelTag,
    };
  }

  /**
   * Classification helper — wraps complete() with a structured classification prompt.
   */
  async classify({ agentId, text, categories, provider, model, requestType = 'triage' }) {
    const prompt = `Classify the following text into exactly one of these categories: ${categories.join(', ')}

Text: ${text}

Respond with ONLY the category name, nothing else.`;

    const result = await this.complete({
      agentId,
      provider: provider || this.config.llm.triage.provider,
      model: model || this.config.llm.triage.model,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.1, maxTokens: 20 },
      requestType,
    });

    const category = result.response.trim();
    return {
      category,
      raw: result.response,
      usage: result.usage,
    };
  }

  // --- Provider Implementations ---

  async _ollamaComplete(model, messages, options) {
    const ollamaConfig = this.providers.ollama || {};
    const host = ollamaConfig.host || 'localhost';
    const port = ollamaConfig.port || 11434;
    const timeout = options.timeout || 60000;

    // Convert messages array to Ollama chat format
    const postData = JSON.stringify({
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      options: {
        temperature: options.temperature ?? 0.3,
        num_predict: options.maxTokens || 2048,
      },
    });

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: host,
        port,
        path: '/api/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({
              response: (parsed.message?.content || '').trim(),
              usage: {
                inputTokens: parsed.prompt_eval_count || 0,
                outputTokens: parsed.eval_count || 0,
              },
              modelDigest: parsed.model || model,
            });
          } catch (e) {
            reject(new Error(`Ollama parse error: ${e.message}`));
          }
        });
      });

      req.on('error', e => reject(new Error(`Ollama connection error: ${e.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
      req.write(postData);
      req.end();
    });
  }

  async _geminiComplete(model, messages, options) {
    const keyEnvVar = this.providers.google?.keyEnvVar || 'GOOGLE_API_KEY';
    const apiKey = process.env[keyEnvVar];
    if (!apiKey) throw new Error(`Missing env var ${keyEnvVar} for Gemini`);

    const timeout = options.timeout || 30000;

    // Convert messages to Gemini format
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const systemInstruction = messages.find(m => m.role === 'system');

    const body = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.3,
        maxOutputTokens: options.maxTokens || 8192,
        // Disable thinking budget for Gemini 2.5 Pro to prevent it consuming all output tokens
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction.content }] };
    }

    const postData = JSON.stringify(body);
    console.log(`[LLM/Gemini] Request: model=${model}, maxOutputTokens=${body.generationConfig?.maxOutputTokens}, messages=${contents.length}`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const parsed = new URL(url);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);

            if (result.error) {
              const code = result.error.code;
              if (code === 429) {
                const err = new Error(`Gemini rate limited: ${result.error.message}`);
                err.name = 'RateLimitError';
                err.retryable = true;
                reject(err);
                return;
              }
              reject(new Error(`Gemini API error ${code}: ${result.error.message}`));
              return;
            }

            const text = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const usage = result.usageMetadata || {};
            if (!text) {
              console.warn('[LLM/Gemini] Empty response. Raw result:', JSON.stringify(result).substring(0, 500));
            }
            resolve({
              response: text.trim(),
              usage: {
                inputTokens: usage.promptTokenCount || 0,
                outputTokens: usage.candidatesTokenCount || 0,
              },
            });
          } catch (e) {
            reject(new Error(`Gemini parse error: ${e.message}`));
          }
        });
      });

      req.on('error', e => reject(new Error(`Gemini connection error: ${e.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Gemini timeout')); });
      req.write(postData);
      req.end();
    });
  }

  async _anthropicComplete(model, messages, options) {
    const keyEnvVar = this.providers.anthropic?.keyEnvVar || 'ANTHROPIC_API_KEY';
    const apiKey = process.env[keyEnvVar];
    if (!apiKey) throw new Error(`Missing env var ${keyEnvVar} for Anthropic`);

    const timeout = options.timeout || 30000;
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const body = {
      model,
      max_tokens: options.maxTokens || 2048,
      messages: nonSystem.map(m => ({ role: m.role, content: m.content })),
    };
    if (systemMsg) body.system = systemMsg.content;
    if (options.temperature !== undefined) body.temperature = options.temperature;

    const postData = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        timeout,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.error) {
              if (result.error.type === 'rate_limit_error') {
                const err = new Error(`Anthropic rate limited: ${result.error.message}`);
                err.name = 'RateLimitError';
                err.retryable = true;
                reject(err);
                return;
              }
              reject(new Error(`Anthropic API error: ${result.error.message}`));
              return;
            }
            const text = result.content?.[0]?.text || '';
            resolve({
              response: text.trim(),
              usage: {
                inputTokens: result.usage?.input_tokens || 0,
                outputTokens: result.usage?.output_tokens || 0,
              },
            });
          } catch (e) {
            reject(new Error(`Anthropic parse error: ${e.message}`));
          }
        });
      });

      req.on('error', e => reject(new Error(`Anthropic connection error: ${e.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Anthropic timeout')); });
      req.write(postData);
      req.end();
    });
  }

  /**
   * Estimate cost in millicents based on provider pricing.
   * Returns 0 for local models.
   */
  _estimateCost(provider, model, usage) {
    if (provider === 'ollama') return 0;

    // Approximate pricing (millicents per 1K tokens)
    const pricing = {
      'google': {
        'gemini-2.5-pro': { input: 125, output: 500 },    // $1.25/$5.00 per 1M
        'gemini-2.5-flash': { input: 15, output: 60 },     // $0.15/$0.60 per 1M
      },
      'anthropic': {
        'claude-sonnet-4-6': { input: 300, output: 1500 }, // $3/$15 per 1M
        'claude-opus-4-6': { input: 1500, output: 7500 },  // $15/$75 per 1M
        'claude-haiku-4-5': { input: 80, output: 400 },    // $0.80/$4 per 1M
      },
    };

    const modelPricing = pricing[provider]?.[model];
    if (!modelPricing) return 0;

    const inputCost = (usage.inputTokens / 1000) * modelPricing.input;
    const outputCost = (usage.outputTokens / 1000) * modelPricing.output;
    return Math.round(inputCost + outputCost);
  }
}

module.exports = { LLMService };
