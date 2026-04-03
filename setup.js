#!/usr/bin/env node
/**
 * Darkhan — Interactive Setup Wizard
 *
 * Guides a new user through first-time setup:
 *   1. Check prerequisites (Node.js, Ollama)
 *   2. Instance name + branding
 *   3. Admin account creation
 *   4. API keys (optional)
 *   5. Generate .env + darkhan.config.json
 *   6. Pull Ollama model
 *   7. Install dependencies
 *   8. Seed database
 *   9. Start server
 *
 * Usage: node setup.js
 */

const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const os = require('os');
const SERVER_DIR = path.join(__dirname, 'server');
const OS = os.platform();
const ENV_PATH = path.join(SERVER_DIR, '.env');
const CONFIG_PATH = path.join(SERVER_DIR, 'darkhan.config.json');

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  accent: '\x1b[38;5;214m', // orange
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultValue = '') {
  const display = defaultValue ? `${question} ${c.dim}[${defaultValue}]${c.reset}: ` : `${question}: `;
  return new Promise(resolve => {
    rl.question(display, answer => resolve(answer.trim() || defaultValue));
  });
}

function askSecret(question) {
  return new Promise(resolve => {
    process.stdout.write(`${question}: `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    let input = '';
    const onData = (ch) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r') {
        if (stdin.setRawMode) stdin.setRawMode(wasRaw);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (c === '\x7f' || c === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (c === '\x03') {
        process.exit(0);
      } else {
        input += c;
        process.stdout.write('*');
      }
    };
    stdin.resume();
    stdin.on('data', onData);
  });
}

function print(msg) { console.log(msg); }
function banner(msg) { print(`\n${c.accent}${c.bold}${msg}${c.reset}`); }
function success(msg) { print(`${c.green}  ✓${c.reset} ${msg}`); }
function warn(msg) { print(`${c.accent}  ⚠${c.reset} ${msg}`); }
function fail(msg) { print(`${c.red}  ✗${c.reset} ${msg}`); }
function info(msg) { print(`${c.dim}  ${msg}${c.reset}`); }

function checkCommand(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

/**
 * Import a portable config exported from another Darkhan instance.
 * Shows the human exactly what will be applied, waits for confirmation.
 * Generates fresh secrets (passwords, keys, keypairs) — never imports them.
 */
async function importConfig(configPath) {
  print('');
  print(`${c.accent}${c.bold}╔══════════════════════════════════════╗${c.reset}`);
  print(`${c.accent}${c.bold}║     Darkhan — The Forge              ║${c.reset}`);
  print(`${c.accent}${c.bold}║     Import Configuration             ║${c.reset}`);
  print(`${c.accent}${c.bold}╚══════════════════════════════════════╝${c.reset}`);
  print('');

  // Load and validate the portable config
  if (!fs.existsSync(configPath)) {
    fail(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  let imported;
  try {
    imported = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    fail(`Invalid JSON in config file: ${e.message}`);
    process.exit(1);
  }

  // Validate format
  if (!imported._meta || imported._meta.format !== 'darkhan-portable-config-v1') {
    fail('Not a valid Darkhan portable config file.');
    info('Expected format: darkhan-portable-config-v1');
    info('Export one with: node scripts/export-config.js -o config.json');
    process.exit(1);
  }

  // Verify signature if present
  if (imported._meta.signature && imported._meta.signingKey) {
    try {
      const configCopy = JSON.parse(JSON.stringify(imported));
      delete configCopy._meta.signature;
      delete configCopy._meta.signingKey;
      const configData = JSON.stringify(configCopy);
      const publicKeyObj = crypto.createPublicKey(imported._meta.signingKey);
      const valid = crypto.verify(
        null,
        Buffer.from(configData),
        publicKeyObj,
        Buffer.from(imported._meta.signature, 'base64')
      );
      if (valid) {
        success('Config signature verified — exported by a trusted Darkhan instance');
      } else {
        warn('Config signature INVALID — config may have been tampered with');
        const proceed = await ask('Continue anyway? [y/N]', 'n');
        if (proceed.toLowerCase() !== 'y') process.exit(1);
      }
    } catch (e) {
      warn(`Could not verify signature: ${e.message}`);
    }
  } else {
    warn('Config is unsigned — cannot verify origin');
    info('This is normal for manually shared configs.');
  }

  // Show the human exactly what this config contains
  banner('Configuration Review');
  info(`Exported from: ${imported._meta.exportedFrom} on ${imported._meta.exportedAt}`);
  print('');

  print(`${c.bold}  Instance:${c.reset}`);
  print(`    Name:     ${imported.instance?.name || 'My Forge'}`);
  print(`    Brand:    ${imported.instance?.brandName || 'Darkhan'}`);
  print(`    Port:     ${imported.instance?.port || 3001}`);
  print(`    Timezone: ${imported.instance?.timezone || 'America/New_York'}`);
  print('');

  print(`${c.bold}  Team Members:${c.reset}`);
  for (const member of (imported.team?.members || [])) {
    const type = member.type === 'human' ? `${c.green}[human]${c.reset}` : `${c.cyan}[agent]${c.reset}`;
    const model = member.model ? ` — ${member.model.provider}/${member.model.model}` : '';
    const perms = member.permissions?.shell ? ` (shell: ${member.permissions.shell})` : '';
    print(`    ${type} ${member.name} (${member.id})${model}${perms}`);
  }
  print('');

  print(`${c.bold}  Channels:${c.reset}`);
  for (const ch of (imported.channels || [])) {
    print(`    ${ch.name} — ${ch.description}`);
  }
  print('');

  print(`${c.bold}  LLM Providers:${c.reset}`);
  for (const [name] of Object.entries(imported.llm?.providers || {})) {
    print(`    ${name}`);
  }
  print('');

  print(`${c.bold}  What will be generated fresh on THIS node:${c.reset}`);
  print(`    ${c.green}✓${c.reset} New admin password (you set it on first login)`);
  print(`    ${c.green}✓${c.reset} New lockdown PIN (you set it on first login)`);
  print(`    ${c.green}✓${c.reset} New session secret`);
  print(`    ${c.green}✓${c.reset} New Ed25519 keypair (unique to this node)`);
  print(`    ${c.green}✓${c.reset} New API keys for each agent`);
  print(`    ${c.green}✓${c.reset} Fresh database`);
  print('');

  print(`${c.bold}  What will NOT be imported:${c.reset}`);
  print(`    ${c.accent}⚠${c.reset} No passwords, API keys, or secrets from the source`);
  print(`    ${c.accent}⚠${c.reset} No message history or activity logs`);
  print(`    ${c.accent}⚠${c.reset} No folio path (you will set your own)`);
  print('');

  const confirm = await ask(`${c.bold}Apply this configuration?${c.reset} [y/N]`, 'n');
  if (confirm.toLowerCase() !== 'y') {
    print('Cancelled. No changes made.');
    rl.close();
    process.exit(0);
  }

  // Let the human customize node-specific settings
  banner('Node-Specific Settings');

  const instanceName = await ask('Instance name for THIS node', imported.instance?.name || 'My Forge');
  const port = await ask('Port', String(imported.instance?.port || 3001));
  const timezone = await ask('Timezone', imported.instance?.timezone || 'America/New_York');
  const folioPath = await ask('Folio path (or Enter to skip)', '');

  // API keys
  banner('API Keys');
  info('The source config used these providers. Enter keys for the ones you want to enable:');
  const providerKeys = {};
  for (const [name, prov] of Object.entries(imported.llm?.providers || {})) {
    if (name === 'ollama') continue; // Local, no key needed
    const key = await ask(`  ${name} API key (Enter to skip)`, '');
    if (key) providerKeys[name] = key;
  }

  // Admin setup
  banner('Admin Account');
  const adminMember = (imported.team?.members || []).find(m => m.role === 'admin');
  const adminName = await ask('Your name', adminMember?.name || 'Admin');
  const adminUsername = adminName.toLowerCase().replace(/[^a-z0-9]/g, '');
  info(`Login username: ${adminUsername}`);
  info('You will set your password and lockdown PIN after your first login.');

  // Build the full config for this node
  const sessionSecret = crypto.randomBytes(32).toString('hex');

  // Merge imported structure with node-specific values
  const nodeConfig = {
    instance: {
      name: instanceName,
      brandName: imported.instance?.brandName || 'Darkhan',
      port: parseInt(port),
      timezone,
    },
    team: imported.team,
    llm: {
      triage: imported.llm?.triage,
      providers: {
        ollama: imported.llm?.providers?.ollama || { host: 'localhost', port: 11434 },
        ...(providerKeys.google ? { google: { keyEnvVar: 'GOOGLE_API_KEY' } } : {}),
        ...(providerKeys.anthropic ? { anthropic: { keyEnvVar: 'ANTHROPIC_API_KEY' } } : {}),
      },
      globalRateLimits: imported.llm?.globalRateLimits || {},
    },
    channels: imported.channels,
    ...(folioPath ? { folio: { path: folioPath } } : {}),
    sandbox: imported.sandbox || { processIsolation: false },
    federation: { enabled: false },  // Federation is opt-in after setup
  };

  // Update admin member with local identity
  const adminIdx = nodeConfig.team.members.findIndex(m => m.role === 'admin');
  if (adminIdx !== -1) {
    nodeConfig.team.members[adminIdx].id = `user_${adminUsername}`;
    nodeConfig.team.members[adminIdx].name = adminName;
  }

  // Generate .env
  const envContent = [
    '# Darkhan — Environment Configuration',
    `# Generated by setup wizard (imported config) on ${new Date().toISOString()}`,
    `# Source: ${imported._meta.exportedFrom}`,
    '# NEVER commit this file to version control.',
    '',
    `PORT=${port}`,
    `SESSION_SECRET=${sessionSecret}`,
    `CORS_ORIGIN=http://localhost:${port}`,
    '',
    '# Local LLM',
    'OLLAMA_HOST=localhost',
    'OLLAMA_PORT=11434',
    `OLLAMA_MODEL=${imported.llm?.triage?.model || 'qwen2.5:14b'}`,
    '',
    '# Cloud APIs',
    providerKeys.google ? `GOOGLE_API_KEY=${providerKeys.google}` : '# GOOGLE_API_KEY=',
    providerKeys.anthropic ? `ANTHROPIC_API_KEY=${providerKeys.anthropic}` : '# ANTHROPIC_API_KEY=',
    '',
    '# Claude Relay',
    'DARKHAN_RELAY_MODE=cli',
    '',
  ].join('\n');

  fs.writeFileSync(ENV_PATH, envContent, { mode: 0o600 });
  success('.env generated');

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(nodeConfig, null, 2));
  success('darkhan.config.json generated');

  // Copy worker files for agents that reference them
  for (const member of nodeConfig.team.members) {
    if (member.worker) {
      const workerSrc = path.join(SERVER_DIR, 'workers', 'examples', 'assistant.worker.js');
      const workerDst = path.join(SERVER_DIR, 'workers', member.worker);
      if (fs.existsSync(workerSrc) && !fs.existsSync(workerDst)) {
        let workerCode = fs.readFileSync(workerSrc, 'utf8');
        workerCode = workerCode.replace(/id:\s*'agent_\w+'/, `id: '${member.id}'`);
        workerCode = workerCode.replace(/name:\s*'[^']+'/, `name: '${member.name}'`);
        fs.writeFileSync(workerDst, workerCode);
        success(`Worker file created: workers/${member.worker}`);
      }
    }
  }

  // Return to the normal setup flow for deps, db seed, and server start
  return { sessionSecret, adminUsername, port, nodeConfig };
}

async function main() {
  // Check for --from-config flag
  const args = process.argv.slice(2);
  const configFlagIndex = args.indexOf('--from-config');

  if (configFlagIndex !== -1) {
    const configPath = args[configFlagIndex + 1];
    if (!configPath) {
      fail('Usage: node setup.js --from-config <path-to-config.json>');
      process.exit(1);
    }
    const result = await importConfig(configPath);
    // Skip to dependency install + db seed + server start
    await finishSetup(result.sessionSecret, result.adminUsername, result.port);
    return;
  }

  print('');
  print(`${c.accent}${c.bold}╔══════════════════════════════════════╗${c.reset}`);
  print(`${c.accent}${c.bold}║     Darkhan — The Forge              ║${c.reset}`);
  print(`${c.accent}${c.bold}║     Setup Wizard                     ║${c.reset}`);
  print(`${c.accent}${c.bold}╚══════════════════════════════════════╝${c.reset}`);
  print('');

  // ── Step 1: Prerequisites ──
  banner('Step 1: Checking prerequisites');

  // Node.js
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1));
  if (nodeMajor >= 20) {
    success(`Node.js ${nodeVersion}`);
  } else {
    fail(`Node.js ${nodeVersion} — need 20+. Run: brew install node`);
    process.exit(1);
  }

  // Ollama
  if (checkCommand('ollama')) {
    success('Ollama installed');
    // Check if running
    try {
      execSync('curl -s http://localhost:11434/api/tags', { stdio: 'pipe', timeout: 3000 });
      success('Ollama is running');
    } catch {
      warn('Ollama not running. Starting...');
      try {
        execSync('brew services start ollama', { stdio: 'pipe' });
        // Wait for it
        await new Promise(r => setTimeout(r, 3000));
        success('Ollama started');
      } catch {
        warn('Could not start Ollama. Run manually: brew services start ollama');
      }
    }
  } else {
    fail('Ollama not installed. Run: brew install ollama');
    const cont = await ask('Continue without Ollama? (local LLM will not work) [y/N]', 'n');
    if (cont.toLowerCase() !== 'y') process.exit(1);
  }

  // Git
  if (checkCommand('git')) {
    success('Git installed');
  } else {
    warn('Git not found — install Xcode CLT: xcode-select --install');
  }

  // Check if already configured
  if (fs.existsSync(CONFIG_PATH) && fs.existsSync(ENV_PATH)) {
    print('');
    warn('Darkhan is already configured.');
    const overwrite = await ask('Overwrite existing configuration? [y/N]', 'n');
    if (overwrite.toLowerCase() !== 'y') {
      print('Keeping existing configuration. Run `cd server && node server.js` to start.');
      rl.close();
      process.exit(0);
    }
  }

  // ── Step 2: Instance Setup ──
  banner('Step 2: Your Darkhan instance');

  const instanceName = await ask('Instance name (your team or project)', 'My Forge');
  const brandName = await ask('Brand name (shown in UI)', 'Darkhan');
  const port = await ask('Port', '3001');
  const timezone = await ask('Timezone (IANA format)', 'America/New_York');

  // ── Step 3: Admin Account ──
  banner('Step 3: Admin account');
  info('This is the human admin who controls the system.');

  const adminName = await ask('Your name', 'Admin');
  const adminId = `user_${adminName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const adminUsername = adminName.toLowerCase().replace(/[^a-z0-9]/g, '');
  info(`Login username: ${adminUsername}`);
  info('You will set your password and lockdown PIN after your first login.');

  // Default password — user changes it on first login (forced)
  const adminPassword = 'changeme';
  const lockdownPin = '';

  // ── Step 4: Local LLM ──
  banner('Step 4: Local LLM');

  let ollamaModel = 'qwen2.5:14b';
  const totalMemGB = Math.round(require('os').totalmem() / (1024 ** 3));
  if (totalMemGB >= 16) {
    info(`Detected ${totalMemGB}GB RAM — defaulting to 14B model (recommended).`);
    const modelChoice = await ask('Model size: 14b (accurate, 16GB+, recommended) or 3b (fast, 8GB+)', '14b');
    ollamaModel = modelChoice === '3b' ? 'qwen2.5:3b' : 'qwen2.5:14b';
  } else {
    warn(`Detected ${totalMemGB}GB RAM — less than 16GB. The 14B model may not run well.`);
    const modelChoice = await ask('Model size: 3b (recommended for your hardware) or 14b (may be slow)', '3b');
    ollamaModel = modelChoice === '14b' ? 'qwen2.5:14b' : 'qwen2.5:3b';
  }

  // Pull model
  try {
    print('');
    info(`Pulling ${ollamaModel}... (this may take a few minutes on first run)`);
    execSync(`ollama pull ${ollamaModel}`, { stdio: 'inherit' });
    success(`Model ${ollamaModel} ready`);
  } catch {
    warn(`Could not pull model. Run manually: ollama pull ${ollamaModel}`);
  }

  // ── Step 5: API Keys ──
  banner('Step 5: API keys (optional)');
  info('Cloud APIs enable smarter agents and two-LLM security consensus.');
  info('You can skip these and add them later in .env.');

  const googleKey = await ask('Google API key (for Gemini agents) — Enter to skip', '');
  const anthropicKey = await ask('Anthropic API key (for Claude escalation) — Enter to skip', '');
  const openaiKey = await ask('OpenAI API key (for GPT consensus model) — Enter to skip', '');

  // ── Step 6: Folio ──
  banner('Step 6: Knowledge base (folio)');
  info('Darkhan can browse and search a folder of markdown files.');
  const folioPath = await ask('Folio path (or Enter to skip)', '');

  // ── Step 7: First agent ──
  banner('Step 7: Your first agent');
  info('Every Darkhan needs at least one agent. We will create a local assistant.');

  const agentName = await ask('Agent name', 'Assistant');
  const agentId = `agent_${agentName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

  // ── Generate Configuration ──
  banner('Generating configuration...');

  // SESSION_SECRET
  const sessionSecret = crypto.randomBytes(32).toString('hex');

  // .env
  const envContent = [
    '# Darkhan — Environment Configuration',
    `# Generated by setup wizard on ${new Date().toISOString()}`,
    '# NEVER commit this file to version control.',
    '',
    `PORT=${port}`,
    `SESSION_SECRET=${sessionSecret}`,
    `CORS_ORIGIN=http://localhost:${port}`,
    '',
    '# Local LLM',
    'OLLAMA_HOST=localhost',
    'OLLAMA_PORT=11434',
    `OLLAMA_MODEL=${ollamaModel}`,
    '',
    '# Cloud APIs',
    googleKey ? `GOOGLE_API_KEY=${googleKey}` : '# GOOGLE_API_KEY=',
    anthropicKey ? `ANTHROPIC_API_KEY=${anthropicKey}` : '# ANTHROPIC_API_KEY=',
    openaiKey ? `OPENAI_API_KEY=${openaiKey}` : '# OPENAI_API_KEY=',
    '',
    '# Claude Relay',
    'DARKHAN_RELAY_MODE=cli',
    '',
  ].join('\n');

  fs.writeFileSync(ENV_PATH, envContent);
  success('.env generated');

  // darkhan.config.json
  const config = {
    instance: {
      name: instanceName,
      brandName,
      port: parseInt(port),
      timezone,
    },
    team: {
      members: [
        {
          id: adminId,
          name: adminName,
          type: 'human',
          role: 'admin',
          channels: ['chan_command', 'chan_alerts'],
        },
        {
          id: agentId,
          name: agentName,
          type: 'agent',
          role: 'agent',
          model: {
            provider: 'ollama',
            model: ollamaModel,
            mode: 'worker',
          },
          rateLimits: { requestsPerDay: 0, requestsPerMinute: 0 },
          permissions: { shell: 'restricted' },
          channels: ['chan_command', 'chan_alerts'],
        },
      ],
    },
    llm: {
      triage: { provider: 'ollama', model: ollamaModel },
      providers: {
        ollama: { host: 'localhost', port: 11434 },
        ...(googleKey ? { google: { keyEnvVar: 'GOOGLE_API_KEY' } } : {}),
        ...(anthropicKey ? { anthropic: { keyEnvVar: 'ANTHROPIC_API_KEY' } } : {}),
        ...(openaiKey ? { openai: { keyEnvVar: 'OPENAI_API_KEY' } } : {}),
      },
      globalRateLimits: {
        ollama: { requestsPerDay: 0, requestsPerMinute: 0 },
        ...(googleKey ? { google: { requestsPerDay: 1000, requestsPerMinute: 15 } } : {}),
        ...(anthropicKey ? { anthropic: { requestsPerDay: 500, requestsPerMinute: 10 } } : {}),
        ...(openaiKey ? { openai: { requestsPerDay: 500, requestsPerMinute: 10 } } : {}),
      },
    },
    channels: [
      { id: 'chan_command', name: '#command', description: 'Primary team channel' },
      { id: 'chan_alerts', name: '#alerts', description: 'System alerts' },
    ],
    ...(folioPath ? { folio: { path: folioPath } } : {}),
    sandbox: { processIsolation: false },  // Start with in-process workers; enable forked mode after testing
    federation: { enabled: false },
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  success('darkhan.config.json generated');

  // Copy example worker so the agent has code to run
  const workerSrc = path.join(SERVER_DIR, 'workers', 'examples', 'assistant.worker.js');
  const workerDst = path.join(SERVER_DIR, 'workers', `${agentName.toLowerCase().replace(/[^a-z0-9]/g, '')}.worker.js`);
  if (fs.existsSync(workerSrc) && !fs.existsSync(workerDst)) {
    let workerCode = fs.readFileSync(workerSrc, 'utf8');
    // Update the agent ID and name in the worker file
    workerCode = workerCode.replace(/id:\s*'agent_\w+'/, `id: '${agentId}'`);
    workerCode = workerCode.replace(/name:\s*'[^']+'/, `name: '${agentName}'`);
    fs.writeFileSync(workerDst, workerCode);
    success(`Worker file created: workers/${path.basename(workerDst)}`);
    // Update config to point to the worker file
    config.team.members[1].worker = path.basename(workerDst);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  // Hand off to shared finish flow
  await finishSetup(sessionSecret, adminUsername, port);
}

/**
 * Shared setup completion — used by both interactive wizard and config import.
 * Handles: npm install, pre-commit hook, db seed, credentials file, server start.
 */
async function finishSetup(sessionSecret, adminUsername, port) {
  // ── Install Dependencies ──
  banner('Installing dependencies...');
  try {
    execSync('npm install', { cwd: SERVER_DIR, stdio: 'inherit' });
    success('Dependencies installed');
  } catch (e) {
    fail('npm install failed: ' + e.message);
    process.exit(1);
  }

  // ── Set up pre-commit hook ──
  try {
    const hookSrc = path.join(__dirname, 'scripts', 'pre-commit-hook.sh');
    const hookDir = path.join(__dirname, '.git', 'hooks');
    const hookDst = path.join(hookDir, 'pre-commit');
    if (fs.existsSync(hookSrc) && fs.existsSync(path.join(__dirname, '.git'))) {
      if (!fs.existsSync(hookDir)) fs.mkdirSync(hookDir, { recursive: true });
      fs.copyFileSync(hookSrc, hookDst);
      fs.chmodSync(hookDst, 0o755);
      success('Pre-commit hook installed (blocks secrets, source maps, db files)');
    }
  } catch {
    warn('Could not install pre-commit hook');
  }

  // ── Seed Database ──
  banner('Initializing database...');
  print('');

  // Remove any stale databases from a previous partial run
  for (const dbFile of ['darkhan.db', 'secrets.db', 'sessions.db']) {
    const dbPath = path.join(SERVER_DIR, 'db', dbFile);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    // Also check server root (some installs put db files here)
    const rootDbPath = path.join(SERVER_DIR, dbFile);
    if (fs.existsSync(rootDbPath)) fs.unlinkSync(rootDbPath);
  }

  try {
    execSync(`node db/seed.js`, {
      cwd: SERVER_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        SESSION_SECRET: sessionSecret,
        DARKHAN_SETUP_PASSWORD: 'changeme',
        DARKHAN_SETUP_PIN: '',
      },
    });
    success('Database seeded');
  } catch (e) {
    fail('Database seed failed: ' + e.message);
    process.exit(1);
  }

  // Save credentials to a file (not stdout) so users don't lose them
  const credsPath = path.join(__dirname, 'darkhan-credentials.txt');
  const credsContent = [
    'Darkhan Credentials',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Admin Login:`,
    `  Username: ${adminUsername}`,
    `  Password: changeme (you MUST change this on first login)`,
    '',
    'API Keys:',
    '  (See seed.js output above)',
    '',
    'IMPORTANT: Delete this file after saving the API keys somewhere safe.',
  ].join('\n');
  fs.writeFileSync(credsPath, credsContent, { mode: 0o600 });
  success(`Credentials saved to darkhan-credentials.txt (mode 600)`);

  // ── Done ──
  print('');
  print(`${c.accent}${c.bold}╔══════════════════════════════════════╗${c.reset}`);
  print(`${c.accent}${c.bold}║     Setup Complete!                  ║${c.reset}`);
  print(`${c.accent}${c.bold}╚══════════════════════════════════════╝${c.reset}`);
  print('');
  print(`${c.bold}  What happens next:${c.reset}`);
  print(`    1. Darkhan will start and open in your browser`);
  print(`    2. Log in with username ${c.accent}${adminUsername}${c.reset} and password ${c.accent}changeme${c.reset}`);
  print(`    3. You will be guided to set a new password and lockdown PIN`);
  print('');
  print(`${c.dim}  API keys saved to: darkhan-credentials.txt (delete after saving)${c.reset}`);
  print('');

  const startNow = await ask('Start Darkhan now? [Y/n]', 'y');
  rl.close();

  if (startNow.toLowerCase() !== 'n') {
    print('');
    info('Starting Darkhan...');
    print('');

    const serverUrl = `http://localhost:${port}`;

    const server = spawn('node', ['server.js'], {
      cwd: SERVER_DIR,
      stdio: 'inherit',
      env: { ...process.env, SESSION_SECRET: sessionSecret },
    });
    server.on('error', (e) => { fail('Failed to start: ' + e.message); process.exit(1); });

    // Wait for server to be ready, then open browser
    setTimeout(() => {
      try {
        if (OS === 'darwin') {
          execSync(`open ${serverUrl}`, { stdio: 'pipe' });
        } else if (OS === 'linux') {
          execSync(`xdg-open ${serverUrl}`, { stdio: 'pipe' });
        }
      } catch {
        print('');
        print(`${c.bold}  Open your browser to: ${c.cyan}${serverUrl}${c.reset}`);
      }
    }, 4000);  // Give server 4 seconds to start
  }
}

main().catch(e => { fail(e.message); process.exit(1); });
