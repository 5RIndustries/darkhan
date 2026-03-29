#!/usr/bin/env node
/**
 * Darkhan — Remote Worker Runner (Node 1)
 *
 * Entry point for running federated workers on a remote node.
 * Workers execute locally (LLM calls, file ops) but post results
 * back to the main Darkhan server on Node 2 via HTTP API.
 *
 * Usage: node remote-runner.js
 *
 * Required .env (same directory):
 *   REMOTE_HOST=http://<darkhan-hub-ip>:3001
 *   CHIEF_API_KEY=dk_agent_xxx
 *   LINDSEY_API_KEY=dk_agent_xxx
 *   GOOGLE_API_KEY=<your-key>
 *   OLLAMA_HOST=localhost
 *   OLLAMA_PORT=11434
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const path = require('path');
const fs = require('fs');
const { FederatedWorkerRuntime } = require('./services/federated-runtime');
const { LLMService } = require('./services/llm');

// --- Load config ---
const configPath = path.join(__dirname, 'darkhan.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// --- Environment ---
const REMOTE_HOST = process.env.REMOTE_HOST || 'http://localhost:3001';

// [DARKHAN SECURITY] mTLS certificate loading for federation
let globalTlsOptions = null;
if (config.tls?.enabled) {
  const resolvePath = (p) => p.replace('~', process.env.HOME);
  try {
    globalTlsOptions = {
      ca: fs.readFileSync(resolvePath(config.tls.ca)),
      cert: fs.readFileSync(resolvePath(config.tls.cert)),
      key: fs.readFileSync(resolvePath(config.tls.key)),
    };
    console.log('[RemoteRunner] mTLS certificates loaded');
  } catch (e) {
    console.error(`[RemoteRunner] FATAL: Could not load TLS certificates: ${e.message}`);
    process.exit(1);
  }
}

// [DARKHAN SECURITY] TLS enforcement for federation
// HTTP is acceptable on Tailscale networks (WireGuard-encrypted). For non-Tailscale
// deployments, require HTTPS or explicit opt-in via FEDERATION_ALLOW_HTTP=true.
if (REMOTE_HOST.startsWith('http://')) {
  if (process.env.FEDERATION_ALLOW_HTTP === 'true') {
    console.warn('[RemoteRunner] WARNING: Federation using unencrypted HTTP. ' +
      'This is acceptable on Tailscale networks. For non-Tailscale deployments, use HTTPS.');
  } else {
    console.error('[RemoteRunner] FATAL: Federation target uses HTTP (unencrypted). ' +
      'Set FEDERATION_ALLOW_HTTP=true if running on a Tailscale/WireGuard network, ' +
      'or use an https:// URL for REMOTE_HOST.');
    process.exit(1);
  }
}

const apiKeys = {};
if (process.env.CHIEF_API_KEY) apiKeys['agent_chief'] = process.env.CHIEF_API_KEY;
if (process.env.LINDSEY_API_KEY) apiKeys['agent_lindsey'] = process.env.LINDSEY_API_KEY;

// --- Stubs for services that aren't needed locally or are lightweight ---

/**
 * Rate limiter stub — pass through, no blocking.
 * Remote workers rely on the server-side rate limiter via API keys.
 */
const rateLimiter = {
  async check(agentId, provider) {
    // No-op: the remote Darkhan server enforces its own rate limits
    return true;
  },
  record(agentId, provider) {
    // No-op
  },
};

/**
 * Cost tracker stub — logs to console.
 */
const costTracker = {
  async record({ agent, provider, model, tokensIn, tokensOut, costMillicents, requestType }) {
    console.log(
      `[CostTracker] ${agent} | ${provider}/${model} | in:${tokensIn} out:${tokensOut} | ${costMillicents}mc | ${requestType}`
    );

    // Optionally POST cost data to Node 2 for centralized tracking
    try {
      const http = require('http');
      const https = require('https');
      const firstKey = Object.values(apiKeys)[0];
      if (!firstKey) return;

      const payload = JSON.stringify({
        channel_id: 'chan_alerts',
        body: `[CostTracker:Node1] ${agent} ${provider}/${model} — ${tokensIn}+${tokensOut} tokens (${costMillicents}mc) [${requestType}]`,
      });

      const url = new URL(REMOTE_HOST);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;
      const reqOpts = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: '/api/messages',
        method: 'POST',
        headers: {
          'X-API-Key': firstKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 5000,
      };

      // [DARKHAN SECURITY] mTLS: attach client certs if available
      if (isHttps && globalTlsOptions) {
        reqOpts.ca = globalTlsOptions.ca;
        reqOpts.cert = globalTlsOptions.cert;
        reqOpts.key = globalTlsOptions.key;
        reqOpts.rejectUnauthorized = true;
      }

      const req = transport.request(reqOpts);
      req.on('error', () => {}); // Swallow — cost reporting is best-effort
      req.write(payload);
      req.end();
    } catch (_) {
      // Best-effort — don't crash over cost reporting
    }
  },
};

/**
 * Activity log stub — logs to console and optionally posts critical events to Node 2.
 */
const activityLog = {
  append({ actor, action, target, details }) {
    const ts = new Date().toISOString();
    const targetStr = target ? ` -> ${target}` : '';
    const detailStr = details ? ` | ${details}` : '';
    console.log(`[Activity] ${ts} ${actor}.${action}${targetStr}${detailStr}`);
  },
};

// --- Override LLM config with local environment ---

// Point Ollama to local instance
if (process.env.OLLAMA_HOST) {
  config.llm.providers.ollama.host = process.env.OLLAMA_HOST;
}
if (process.env.OLLAMA_PORT) {
  config.llm.providers.ollama.port = parseInt(process.env.OLLAMA_PORT, 10);
}

// Use local Google API key
if (process.env.GOOGLE_API_KEY) {
  // LLMService reads from process.env via keyEnvVar, so this is already set
}

// --- Filter config to only workers ---
// Only load team members that have a `worker` field (Chief and Lindsey)
config.team.members = config.team.members.filter(m => m.worker);

console.log(`[RemoteRunner] Remote host: ${REMOTE_HOST}`);
console.log(`[RemoteRunner] Workers to load: ${config.team.members.map(m => m.id).join(', ')}`);
console.log(`[RemoteRunner] API keys configured for: ${Object.keys(apiKeys).join(', ')}`);

// --- Create services ---

const llmService = new LLMService({
  rateLimiter,
  costTracker,
  activityLog,
  config,
});

const runtime = new FederatedWorkerRuntime({
  remoteHost: REMOTE_HOST,
  apiKeys,
  llmService,
  config,
  activityLog,
  costTracker,
});

// --- Start ---

async function main() {
  console.log('[RemoteRunner] =============================================');
  console.log('[RemoteRunner] Darkhan Federated Worker Runner — Node 1');
  console.log('[RemoteRunner] =============================================');
  console.log(`[RemoteRunner] Started at ${new Date().toISOString()}`);
  console.log(`[RemoteRunner] Timezone: ${config.instance?.timezone || 'America/New_York'}`);

  try {
    // Load worker modules and schedule cron tasks
    await runtime.loadAll();

    // Start polling Node 2 for messages (listener-driven tasks)
    runtime.startListenerPolling(5000);

    const status = runtime.getStatus();
    console.log(`[RemoteRunner] ${status.length} worker(s) active:`);
    for (const w of status) {
      console.log(`  - ${w.id} (${w.name}): ${w.tasks.length} scheduled task(s)`);
      for (const t of w.tasks) {
        console.log(`      ${t.name}: ${t.schedule}`);
      }
    }

    console.log('[RemoteRunner] Ready. Ctrl+C to stop.');
  } catch (err) {
    console.error('[RemoteRunner] Startup failed:', err.message);
    process.exit(1);
  }
}

// --- Graceful shutdown ---

process.on('SIGINT', async () => {
  console.log('\n[RemoteRunner] Shutting down...');
  await runtime.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[RemoteRunner] SIGTERM received, shutting down...');
  await runtime.shutdown();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[RemoteRunner] Uncaught exception:', err.message);
  // Don't crash — log and continue. Workers are isolated.
});

process.on('unhandledRejection', (reason) => {
  console.error('[RemoteRunner] Unhandled rejection:', reason);
  // Don't crash — log and continue.
});

main();
