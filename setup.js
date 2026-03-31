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

const SERVER_DIR = path.join(__dirname, 'server');
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

async function main() {
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
  info(`User ID: ${adminId}`);

  // ── Step 4: Local LLM ──
  banner('Step 4: Local LLM');

  let ollamaModel = 'qwen2.5:3b';
  const totalMemGB = Math.round(require('os').totalmem() / (1024 ** 3));
  if (totalMemGB >= 16) {
    info(`Detected ${totalMemGB}GB RAM — you can run the larger 14B model.`);
    const modelChoice = await ask('Model size: 3b (fast, 8GB+) or 14b (accurate, 16GB+)', '3b');
    ollamaModel = modelChoice === '14b' ? 'qwen2.5:14b' : 'qwen2.5:3b';
  } else {
    info(`Detected ${totalMemGB}GB RAM — using 3B model (recommended for your hardware).`);
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

  // ── Step 6: Vault ──
  banner('Step 6: Knowledge base (vault)');
  info('Darkhan can browse and search a folder of markdown files.');
  const vaultPath = await ask('Vault path (or Enter to skip)', '');

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
    '',
    '# Claude Relay',
    'DARYL_RELAY_MODE=cli',
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
      },
      globalRateLimits: {
        ollama: { requestsPerDay: 0, requestsPerMinute: 0 },
        ...(googleKey ? { google: { requestsPerDay: 1000, requestsPerMinute: 15 } } : {}),
        ...(anthropicKey ? { anthropic: { requestsPerDay: 500, requestsPerMinute: 10 } } : {}),
      },
    },
    channels: [
      { id: 'chan_command', name: '#command', description: 'Primary team channel' },
      { id: 'chan_alerts', name: '#alerts', description: 'System alerts' },
    ],
    ...(vaultPath ? { vault: { path: vaultPath } } : {}),
    sandbox: { processIsolation: true },
    federation: { enabled: false },
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  success('darkhan.config.json generated');

  // ── Install Dependencies ──
  banner('Installing dependencies...');
  try {
    execSync('npm install', { cwd: SERVER_DIR, stdio: 'inherit' });
    success('Dependencies installed');
  } catch (e) {
    fail('npm install failed: ' + e.message);
    process.exit(1);
  }

  // ── Set up git hooks ──
  try {
    execSync('git config core.hooksPath .githooks', { cwd: __dirname, stdio: 'pipe' });
    success('Pre-commit secret scanner enabled');
  } catch {
    warn('Could not set up git hooks (not a git repo?)');
  }

  // ── Seed Database ──
  banner('Initializing database...');
  print('');
  try {
    execSync(`node db/seed.js`, {
      cwd: SERVER_DIR,
      stdio: 'inherit',
      env: { ...process.env, SESSION_SECRET: sessionSecret },
    });
    success('Database seeded');
  } catch (e) {
    fail('Database seed failed: ' + e.message);
    process.exit(1);
  }

  // ── Done ──
  print('');
  print(`${c.accent}${c.bold}╔══════════════════════════════════════╗${c.reset}`);
  print(`${c.accent}${c.bold}║     Setup Complete!                  ║${c.reset}`);
  print(`${c.accent}${c.bold}╚══════════════════════════════════════╝${c.reset}`);
  print('');
  print(`${c.bold}  To start Darkhan:${c.reset}`);
  print(`    cd server && node server.js`);
  print('');
  print(`${c.bold}  Then open:${c.reset}`);
  print(`    ${c.cyan}http://localhost:${port}${c.reset}`);
  print('');
  print(`${c.bold}  First login:${c.reset}`);
  print(`    Username: ${c.accent}${adminName.toLowerCase()}${c.reset}`);
  print(`    Password: ${c.accent}(printed above by seed script)${c.reset}`);
  print('');
  print(`${c.bold}  IMPORTANT — do these immediately after login:${c.reset}`);
  print(`    1. Change your password (Settings)`);
  print(`    2. Set a lockdown PIN (Settings)`);
  print('');

  const startNow = await ask('Start Darkhan now? [Y/n]', 'y');
  rl.close();

  if (startNow.toLowerCase() !== 'n') {
    print('');
    info('Starting Darkhan...');
    print('');
    const server = spawn('node', ['server.js'], {
      cwd: SERVER_DIR,
      stdio: 'inherit',
      env: { ...process.env, SESSION_SECRET: sessionSecret },
    });
    server.on('error', (e) => { fail('Failed to start: ' + e.message); process.exit(1); });
  }
}

main().catch(e => { fail(e.message); process.exit(1); });
