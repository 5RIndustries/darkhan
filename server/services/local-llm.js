/**
 * Darkhan — Native Local LLM Provider
 *
 * Replaces Ollama with direct node-llama-cpp inference.
 * Loads GGUF model files from the Ollama models directory
 * and runs inference natively via Metal (Apple Silicon GPU).
 *
 * No external process dependencies. No HTTP API wrapper.
 * Just the model weights and the math.
 */

const fs = require('fs');
const path = require('path');

// node-llama-cpp is ESM-only — cache the dynamic import
let _llamaModule = null;
let _llamaInstance = null;

async function getLlamaModule() {
  if (!_llamaModule) {
    _llamaModule = await import('node-llama-cpp');
  }
  return _llamaModule;
}

async function getLlamaInstance() {
  if (!_llamaInstance) {
    const { getLlama } = await getLlamaModule();
    _llamaInstance = await getLlama();
  }
  return _llamaInstance;
}

class LocalLLMProvider {
  /**
   * @param {Object} opts
   * @param {string} opts.modelsDir - Ollama models directory (default: ~/.ollama/models)
   * @param {number} opts.gpuLayers - GPU layers to offload (-1 = all, 0 = CPU only)
   * @param {number} opts.contextSize - Default context window size
   */
  constructor({ modelsDir, gpuLayers = -1, contextSize = 4096 } = {}) {
    this.modelsDir = modelsDir || path.join(process.env.HOME, '.ollama', 'models');
    this.gpuLayers = gpuLayers;
    this.contextSize = contextSize;
    this._models = new Map();   // modelSpec -> { model, context }
    this._loading = new Map();  // modelSpec -> Promise (prevent double-load)
  }

  /**
   * Resolve an Ollama model spec (e.g., "qwen2.5:14b") to the GGUF blob path.
   * Reads the Ollama manifest to find the model layer.
   */
  resolveModelPath(modelSpec) {
    const [name, tag = 'latest'] = modelSpec.split(':');
    const manifestPath = path.join(
      this.modelsDir, 'manifests', 'registry.ollama.ai', 'library', name, tag
    );

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Model not found: ${modelSpec} (no manifest at ${manifestPath})`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const modelLayer = manifest.layers?.find(
      l => l.mediaType === 'application/vnd.ollama.image.model'
    );

    if (!modelLayer) {
      throw new Error(`No model layer found in manifest for ${modelSpec}`);
    }

    // Ollama stores blobs as sha256-{hash} (no extension)
    const digest = modelLayer.digest.replace(':', '-');
    const blobPath = path.join(this.modelsDir, 'blobs', digest);

    if (!fs.existsSync(blobPath)) {
      throw new Error(`GGUF blob not found: ${blobPath}`);
    }

    return blobPath;
  }

  /**
   * Load a model into memory (lazy, cached).
   * Returns the model and a reusable context.
   */
  async getModel(modelSpec) {
    // Return cached
    if (this._models.has(modelSpec)) {
      return this._models.get(modelSpec);
    }

    // Prevent concurrent loads of the same model
    if (this._loading.has(modelSpec)) {
      return this._loading.get(modelSpec);
    }

    const loadPromise = this._loadModel(modelSpec);
    this._loading.set(modelSpec, loadPromise);

    try {
      const result = await loadPromise;
      this._models.set(modelSpec, result);
      return result;
    } finally {
      this._loading.delete(modelSpec);
    }
  }

  async _loadModel(modelSpec) {
    const ggufPath = this.resolveModelPath(modelSpec);
    const llama = await getLlamaInstance();

    console.log(`[LocalLLM] Loading model: ${modelSpec} from ${ggufPath}`);
    const startTime = Date.now();

    const model = await llama.loadModel({
      modelPath: ggufPath,
      gpuLayers: this.gpuLayers,
    });

    const context = await model.createContext({
      contextSize: this.contextSize,
    });

    const elapsed = Date.now() - startTime;
    console.log(`[LocalLLM] Model ${modelSpec} loaded in ${elapsed}ms`);

    return { model, context, ggufPath };
  }

  /**
   * Chat completion — matches the LLMService internal return format.
   *
   * @param {string} modelSpec - e.g., "qwen2.5:14b"
   * @param {Array} messages - [{ role, content }]
   * @param {Object} options - { temperature, maxTokens, timeout }
   * @returns {{ response: string, usage: { inputTokens, outputTokens }, modelDigest: string }}
   */
  async complete(modelSpec, messages, options = {}) {
    const { model, context, ggufPath } = await this.getModel(modelSpec);
    const { LlamaChatSession } = await getLlamaModule();

    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
    });

    // Build the prompt from messages
    // System message goes first, then alternate user/assistant
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    // Set system prompt if present
    if (systemMsg) {
      session.setChatHistory([{
        type: 'system',
        text: systemMsg.content,
      }]);
    }

    // Build conversation history (all but the last user message)
    const history = [];
    if (systemMsg) {
      history.push({ type: 'system', text: systemMsg.content });
    }
    for (let i = 0; i < chatMessages.length - 1; i++) {
      const m = chatMessages[i];
      if (m.role === 'user') {
        history.push({ type: 'user', text: m.content });
      } else if (m.role === 'assistant') {
        history.push({ type: 'model', response: [m.content] });
      }
    }
    session.setChatHistory(history);

    // The last message should be the user prompt
    const lastMessage = chatMessages[chatMessages.length - 1];
    const prompt = lastMessage?.content || messages[messages.length - 1]?.content || '';

    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.3;

    let response;
    const timeoutMs = options.timeout || 60000;

    // Run inference with timeout
    const inferencePromise = session.prompt(prompt, {
      maxTokens,
      temperature,
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Local LLM inference timeout')), timeoutMs)
    );

    try {
      response = await Promise.race([inferencePromise, timeoutPromise]);
    } finally {
      // Dispose session to free context sequence
      session.dispose();
    }

    // Extract digest from blob filename for traceability
    const blobName = path.basename(ggufPath);
    const modelDigest = blobName.startsWith('sha256-')
      ? blobName.substring(7, 7 + 12) // First 12 chars of hash
      : modelSpec;

    return {
      response: (response || '').trim(),
      usage: {
        inputTokens: 0,  // node-llama-cpp v3 tracks via context; approximate if needed
        outputTokens: 0,
      },
      modelDigest: `local:${modelSpec}@${modelDigest}`,
    };
  }

  /**
   * Simple generate (non-chat, raw prompt) — for auto-responder/review-gate compat.
   */
  async generate(modelSpec, prompt, options = {}) {
    return this.complete(modelSpec, [{ role: 'user', content: prompt }], options);
  }

  /**
   * Dispose all loaded models — call on server shutdown.
   */
  async dispose() {
    for (const [spec, { model }] of this._models) {
      try {
        await model.dispose?.();
        console.log(`[LocalLLM] Unloaded model: ${spec}`);
      } catch (e) {
        console.warn(`[LocalLLM] Error disposing ${spec}:`, e.message);
      }
    }
    this._models.clear();
  }
}

module.exports = { LocalLLMProvider };
