/**
 * Darkhan — LLM Model Integrity Verifier
 *
 * Verifies local LLM model files against their published digests.
 * Detects tampered model weights before they are used for any inference.
 *
 * Threat model: A compromised Ollama model download (supply chain attack)
 * or a locally-modified model file (direct tampering) could contain
 * backdoor behavior, sleeper triggers, or biased outputs.
 *
 * How it works:
 *   1. Reads the Ollama model manifest (contains SHA-256 digests for each layer)
 *   2. Verifies each blob file matches its declared digest
 *   3. Logs results to the activity trail
 *   4. Optionally blocks startup if verification fails
 *
 * This is defense-in-depth against hostile model providers — the
 * verification confirms the model on disk matches what was downloaded.
 * It does NOT protect against a model that was malicious from the source.
 * For that, see the multi-model output comparison strategy.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OLLAMA_MODELS_DIR = path.join(process.env.HOME || '', '.ollama', 'models');
const MANIFESTS_DIR = path.join(OLLAMA_MODELS_DIR, 'manifests', 'registry.ollama.ai', 'library');
const BLOBS_DIR = path.join(OLLAMA_MODELS_DIR, 'blobs');

class ModelVerifier {
  constructor({ activityLog, config }) {
    this.activityLog = activityLog;
    this.config = config;
    this.results = new Map(); // model -> { verified, layers, errors }
  }

  /**
   * Verify all models configured in darkhan.config.json.
   * Returns a summary of verification results.
   */
  async verifyConfiguredModels() {
    const models = this._getConfiguredModels();
    if (models.length === 0) {
      console.log('[ModelVerifier] No local models configured');
      return { verified: 0, failed: 0, skipped: 0, models: {} };
    }

    console.log(`[ModelVerifier] Verifying ${models.length} configured model(s)...`);

    let verified = 0;
    let failed = 0;
    let skipped = 0;
    const results = {};

    for (const { provider, model } of models) {
      if (provider !== 'ollama') {
        // Cloud models can't be verified locally
        skipped++;
        results[model] = { status: 'skipped', reason: 'cloud provider' };
        continue;
      }

      const result = await this.verifyModel(model);
      results[model] = result;

      if (result.status === 'verified') verified++;
      else if (result.status === 'failed') failed++;
      else skipped++;
    }

    const summary = { verified, failed, skipped, models: results };

    // Log to activity trail
    if (this.activityLog) {
      this.activityLog.append({
        actor: 'model_verifier',
        action: failed > 0 ? 'MODEL_VERIFICATION_FAILED' : 'models_verified',
        details: JSON.stringify({
          verified,
          failed,
          skipped,
          failedModels: Object.entries(results)
            .filter(([, r]) => r.status === 'failed')
            .map(([name]) => name),
        }),
      });
    }

    if (failed > 0) {
      console.error(`[ModelVerifier] *** ${failed} MODEL(S) FAILED VERIFICATION ***`);
    } else if (verified > 0) {
      console.log(`[ModelVerifier] All ${verified} local model(s) verified`);
    }

    return summary;
  }

  /**
   * Verify a single Ollama model by checking blob digests against manifest.
   */
  async verifyModel(modelSpec) {
    // Parse model spec (e.g., "qwen2.5:14b" -> name="qwen2.5", tag="14b")
    const [name, tag = 'latest'] = modelSpec.split(':');
    const manifestPath = path.join(MANIFESTS_DIR, name, tag);

    if (!fs.existsSync(manifestPath)) {
      return { status: 'not_found', reason: `Manifest not found: ${manifestPath}` };
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      return { status: 'error', reason: `Cannot parse manifest: ${e.message}` };
    }

    const layers = manifest.layers || [];
    if (layers.length === 0) {
      return { status: 'error', reason: 'Manifest has no layers' };
    }

    const layerResults = [];
    let allValid = true;

    for (const layer of layers) {
      const digest = layer.digest; // "sha256:abc123..."
      if (!digest || !digest.startsWith('sha256:')) {
        layerResults.push({ type: layer.mediaType, status: 'skipped', reason: 'no SHA-256 digest' });
        continue;
      }

      const expectedHash = digest.replace('sha256:', '');
      const blobPath = path.join(BLOBS_DIR, `sha256-${expectedHash}`);

      if (!fs.existsSync(blobPath)) {
        layerResults.push({ type: layer.mediaType, status: 'missing', reason: 'blob file not found' });
        allValid = false;
        continue;
      }

      // For large model files (multi-GB), use streaming hash
      const isModelWeights = layer.mediaType === 'application/vnd.ollama.image.model';
      const actualHash = await this._hashFile(blobPath);

      if (actualHash === expectedHash) {
        const size = fs.statSync(blobPath).size;
        const sizeStr = isModelWeights ? `${(size / 1e9).toFixed(1)}GB` : `${(size / 1024).toFixed(0)}KB`;
        layerResults.push({
          type: layer.mediaType,
          status: 'verified',
          size: sizeStr,
        });
        if (isModelWeights) {
          console.log(`[ModelVerifier] ${name}:${tag} weights verified (${sizeStr})`);
        }
      } else {
        layerResults.push({
          type: layer.mediaType,
          status: 'TAMPERED',
          expected: expectedHash.substring(0, 16) + '...',
          actual: actualHash.substring(0, 16) + '...',
        });
        allValid = false;
        console.error(`[ModelVerifier] *** TAMPERED: ${name}:${tag} layer ${layer.mediaType} ***`);
      }
    }

    return {
      status: allValid ? 'verified' : 'failed',
      model: `${name}:${tag}`,
      layers: layerResults,
    };
  }

  /**
   * Hash a file using streaming SHA-256 (handles multi-GB files without loading into memory).
   */
  _hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Get all unique model configurations from darkhan.config.json.
   */
  _getConfiguredModels() {
    const seen = new Set();
    const models = [];
    const members = this.config?.team?.members || [];

    for (const member of members) {
      if (member.model) {
        const key = `${member.model.provider}:${member.model.model}`;
        if (!seen.has(key)) {
          seen.add(key);
          models.push({ provider: member.model.provider, model: member.model.model });
        }
      }
    }

    // Also check LLM triage config
    if (this.config?.llm?.triage) {
      const key = `${this.config.llm.triage.provider}:${this.config.llm.triage.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        models.push({ provider: this.config.llm.triage.provider, model: this.config.llm.triage.model });
      }
    }

    return models;
  }

  /**
   * Get verification status for API/dashboard.
   */
  getStatus() {
    return {
      modelsDir: OLLAMA_MODELS_DIR,
      exists: fs.existsSync(OLLAMA_MODELS_DIR),
    };
  }
}

module.exports = { ModelVerifier };
