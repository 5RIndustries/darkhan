#!/usr/bin/env node
/**
 * Darkhan — Export Portable Configuration
 *
 * Exports the current Darkhan instance configuration in a portable format
 * suitable for importing on another node (via `node setup.js --from-config`).
 *
 * What it EXPORTS:
 *   - Instance settings (name, brand, timezone, port)
 *   - Team structure (agents, roles, channels, permissions, rate limits)
 *   - Channel definitions
 *   - LLM provider configuration (structure only, not keys)
 *   - Sandbox and federation settings
 *
 * What it STRIPS (never exported):
 *   - API keys, passwords, PINs, session secrets
 *   - Ed25519 keypair (new node generates its own)
 *   - Database contents (messages, activity logs, secrets)
 *   - File paths that are node-specific (vault, TLS certs)
 *   - Worker file contents (code stays in the repo)
 *
 * The exported config is signed with this instance's Ed25519 key so the
 * receiving node can verify it came from a trusted source.
 *
 * Usage:
 *   node scripts/export-config.js                    # prints to stdout
 *   node scripts/export-config.js -o config.json     # writes to file
 *   node scripts/export-config.js --sign              # include Ed25519 signature
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const CONFIG_PATH = path.join(SERVER_DIR, 'darkhan.config.json');
const DB_PATH = path.join(SERVER_DIR, 'db', 'darkhan.db');

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  accent: '\x1b[38;5;214m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

function success(msg) { console.error(`${c.green}  ✓${c.reset} ${msg}`); }
function warn(msg) { console.error(`${c.accent}  ⚠${c.reset} ${msg}`); }
function fail(msg) { console.error(`${c.red}  ✗${c.reset} ${msg}`); }
function info(msg) { console.error(`${c.dim}  ${msg}${c.reset}`); }

// Parse args
const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const outputFile = outputIndex !== -1 ? args[outputIndex + 1] : null;
const shouldSign = args.includes('--sign');

// Load config
if (!fs.existsSync(CONFIG_PATH)) {
  fail('No darkhan.config.json found. Is Darkhan configured?');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Build portable config — strip secrets and node-specific paths
const portable = {
  _meta: {
    exportedAt: new Date().toISOString(),
    exportedFrom: config.instance?.name || 'unknown',
    darkhanVersion: '1.0.0',
    format: 'darkhan-portable-config-v1',
  },
  instance: {
    name: config.instance?.name || 'My Forge',
    brandName: config.instance?.brandName || 'Darkhan',
    port: config.instance?.port || 3001,
    timezone: config.instance?.timezone || 'America/New_York',
  },
  team: {
    members: (config.team?.members || []).map(member => {
      const clean = {
        id: member.id,
        name: member.name,
        type: member.type,
        role: member.role,
        channels: member.channels || [],
      };
      // Preserve agent-specific settings
      if (member.type === 'agent') {
        clean.model = member.model ? {
          provider: member.model.provider,
          model: member.model.model,
          mode: member.model.mode,
        } : undefined;
        clean.rateLimits = member.rateLimits;
        clean.permissions = member.permissions;
        clean.worker = member.worker;  // filename only, not contents
      }
      return clean;
    }),
  },
  channels: (config.channels || []).map(ch => ({
    id: ch.id,
    name: ch.name,
    description: ch.description,
  })),
  llm: {
    triage: config.llm?.triage ? {
      provider: config.llm.triage.provider,
      model: config.llm.triage.model,
    } : undefined,
    providers: Object.fromEntries(
      Object.entries(config.llm?.providers || {}).map(([name, prov]) => {
        // Strip actual keys, keep structure
        const clean = { ...prov };
        delete clean.key;
        delete clean.apiKey;
        return [name, clean];
      })
    ),
    globalRateLimits: config.llm?.globalRateLimits,
  },
  sandbox: config.sandbox ? {
    enabled: config.sandbox.enabled,
    processIsolation: config.sandbox.processIsolation,
    limits: config.sandbox.limits,
  } : undefined,
  federation: {
    enabled: false,  // Always export with federation disabled — new node opts in
    instanceId: null, // New node generates its own
    peers: [],
  },
};

// Remove undefined values for clean JSON
const cleanJSON = JSON.parse(JSON.stringify(portable));

// Sign if requested and keypair is available
if (shouldSign) {
  try {
    if (!fs.existsSync(DB_PATH)) throw new Error('Database not found');

    // Use sqlite3 CLI (no extra dependency) to read the keypair
    const { execSync } = require('child_process');
    const privKey = execSync(
      `sqlite3 '${DB_PATH}' "SELECT value FROM instance_identity WHERE key = 'ed25519_private';"`,
      { encoding: 'utf8', timeout: 5000, shell: '/bin/bash' }
    ).trim();

    if (privKey) {
      const configData = JSON.stringify(cleanJSON);
      const privateKeyObj = crypto.createPrivateKey(privKey);
      const signature = crypto.sign(null, Buffer.from(configData), privateKeyObj).toString('base64');

      const pubKey = execSync(
        `sqlite3 '${DB_PATH}' "SELECT value FROM instance_identity WHERE key = 'ed25519_public';"`,
        { encoding: 'utf8', timeout: 5000, shell: '/bin/bash' }
      ).trim();

      cleanJSON._meta.signature = signature;
      cleanJSON._meta.signingKey = pubKey || null;
      success('Config signed with instance Ed25519 key');
    } else {
      warn('No Ed25519 keypair found — exporting unsigned');
    }
  } catch (e) {
    warn(`Could not sign config: ${e.message}`);
    info('Exporting unsigned config (receiving node will flag as unverified)');
  }
}

// Summary
const agentCount = cleanJSON.team.members.filter(m => m.type === 'agent').length;
const humanCount = cleanJSON.team.members.filter(m => m.type === 'human').length;
const channelCount = cleanJSON.channels.length;

info(`Exporting: ${humanCount} human(s), ${agentCount} agent(s), ${channelCount} channel(s)`);
info('Stripped: API keys, passwords, keypairs, vault paths, TLS certs');

// Output
const output = JSON.stringify(cleanJSON, null, 2);

if (outputFile) {
  fs.writeFileSync(outputFile, output);
  fs.chmodSync(outputFile, 0o644);
  success(`Exported to ${outputFile}`);
} else {
  process.stdout.write(output + '\n');
}
