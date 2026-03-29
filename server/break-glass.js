#!/usr/bin/env node
/**
 * Darkhan — Break Glass Recovery Tool
 *
 * Emergency admin recovery when you're locked out of the web UI.
 * This script runs OUTSIDE of Darkhan's security stack — it operates
 * directly on the database files.
 *
 * SECURITY (Layer 1):
 *   - Destructive commands require an INTERACTIVE TERMINAL (TTY check)
 *   - Destructive commands require the LOCKDOWN PIN (verified against secrets.db)
 *   - Cannot be executed by piping input or from a script
 *   - `status` is the only command that runs without PIN (read-only)
 *   - Every action is logged to the immutable activity trail
 *
 * USAGE:
 *   node break-glass.js status              (no PIN required)
 *   node break-glass.js reset-password      (requires TTY + PIN)
 *   node break-glass.js lift-lockdown       (requires TTY + PIN)
 *   node break-glass.js reset-baseline      (requires TTY + PIN)
 */

const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SERVER_DIR = __dirname;
const DB_PATH = path.join(SERVER_DIR, 'db', 'darkhan.db');
const SECRETS_PATH = path.join(SERVER_DIR, 'db', 'secrets.db');
const BASELINE_PATH = path.join(process.env.HOME, '.darkhan-integrity-baseline.json');

// Commands that require PIN authentication
const DESTRUCTIVE_COMMANDS = ['reset-password', 'lift-lockdown', 'reset-baseline'];

function openDb(dbPath) {
  const sqlite3 = require('sqlite3').verbose();
  return new sqlite3.Database(dbPath);
}

/**
 * Prompt for input with optional hidden echo (for PIN entry).
 * REQUIRES a real TTY — will fail if stdin is piped or scripted.
 */
function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('SECURITY: This command requires an interactive terminal (TTY). Cannot run from scripts or pipes.'));
      return;
    }

    if (hidden) {
      // Use raw mode to hide PIN input
      process.stdout.write(question);
      const chars = [];
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      const onData = (char) => {
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(chars.join(''));
        } else if (char === '\u0003') {
          // Ctrl+C
          process.stdin.setRawMode(false);
          process.exit(1);
        } else if (char === '\u007F' || char === '\b') {
          // Backspace
          if (chars.length > 0) {
            chars.pop();
            process.stdout.write('\b \b');
          }
        } else {
          chars.push(char);
          process.stdout.write('*');
        }
      };

      process.stdin.on('data', onData);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, answer => { rl.close(); resolve(answer); });
    }
  });
}

/**
 * Verify the lockdown PIN against secrets.db.
 * Returns true if PIN matches, false otherwise.
 */
async function verifyPin(pin) {
  const bcrypt = require('bcrypt');
  const secretsDb = openDb(SECRETS_PATH);

  return new Promise((resolve) => {
    secretsDb.get("SELECT value FROM secret_settings WHERE key = 'lockdown_pin_hash'", [], async (err, row) => {
      secretsDb.close();

      if (err || !row) {
        // No PIN set — fall back to first admin user's password verification
        console.log('No lockdown PIN set. Verifying against admin password instead.');
        const secretsDb2 = openDb(SECRETS_PATH);
        // Find the first admin user dynamically
        const mainDb = openDb(DB_PATH);
        const adminUser = await new Promise(resolve => {
          mainDb.get("SELECT id FROM users WHERE role = 'admin' AND type = 'human' LIMIT 1", [], (e, r) => {
            mainDb.close();
            resolve(r?.id || 'user_admin');
          });
        });
        secretsDb2.get("SELECT password_hash FROM credentials WHERE user_id = ?", [adminUser], async (err2, row2) => {
          secretsDb2.close();
          if (err2 || !row2) {
            console.error('Cannot verify identity — no PIN or password hash found.');
            resolve(false);
            return;
          }
          try {
            const match = await bcrypt.compare(pin, row2.password_hash);
            resolve(match);
          } catch (e) {
            resolve(false);
          }
        });
        return;
      }

      try {
        const match = await bcrypt.compare(pin, row.value);
        resolve(match);
      } catch (e) {
        resolve(false);
      }
    });
  });
}

/**
 * Gate function: verify TTY and PIN before running a destructive command.
 */
async function requireAuth(commandName) {
  // TTY check — prevents scripted execution
  if (!process.stdin.isTTY) {
    console.error('\n=== ACCESS DENIED ===');
    console.error(`"${commandName}" requires an interactive terminal.`);
    console.error('This command cannot be run from scripts, pipes, or automated agents.');
    console.error('You must run it directly from a terminal session.\n');
    process.exit(1);
  }

  console.log(`\n[SECURITY] "${commandName}" requires authentication.`);
  console.log('Enter your lockdown PIN (or admin password if no PIN is set).\n');

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      const pin = await prompt('PIN: ', { hidden: true });
      if (!pin || pin.length === 0) {
        console.log('Aborted.');
        process.exit(1);
      }

      const valid = await verifyPin(pin);
      if (valid) {
        console.log('Authenticated.\n');

        // Log the authentication to activity trail
        const db = openDb(DB_PATH);
        logAction(db, 'break_glass_authenticated', { command: commandName, method: 'pin' });
        db.close();
        return; // Success
      }

      attempts++;
      const remaining = maxAttempts - attempts;
      if (remaining > 0) {
        console.log(`Invalid PIN. ${remaining} attempt(s) remaining.`);
      }
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }

  console.error('\nToo many failed attempts. Aborting.');

  // Log failed authentication
  const db = openDb(DB_PATH);
  logAction(db, 'break_glass_auth_failed', { command: commandName, attempts: maxAttempts });
  db.close();

  process.exit(1);
}

function logAction(db, action, details) {
  const entryData = `break_glass|${action}|admin_recovery|${JSON.stringify(details)}|standalone|event`;
  const hash = crypto.createHash('sha256').update('genesis' + entryData).digest('hex');
  db.run(
    `INSERT INTO activity_log (actor, action, target, details, chain_hash, origin, entry_type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['break_glass', action, 'admin_recovery', JSON.stringify(details), hash, 'standalone', 'event']
  );
}

// --- Commands ---

async function status() {
  console.log('\n=== Darkhan System Status ===\n');

  const db = openDb(DB_PATH);

  // Check lockdown state
  await new Promise(resolve => {
    db.get("SELECT value FROM settings WHERE key = 'lockdown_state'", [], (err, row) => {
      if (err || !row) {
        console.log('Lockdown: UNKNOWN (no state found)');
      } else {
        try {
          const state = JSON.parse(row.value);
          console.log(`Lockdown: ${state.active ? 'ACTIVE — ' + state.reason : 'Inactive'}`);
          if (state.active) console.log(`  Triggered by: ${state.triggeredBy} at ${state.activatedAt}`);
        } catch (e) {
          console.log('Lockdown: UNKNOWN (parse error)');
        }
      }
      resolve();
    });
  });

  // Check users
  await new Promise(resolve => {
    db.all('SELECT id, username, role, type FROM users', [], (err, rows) => {
      console.log(`\nUsers: ${rows?.length || 0}`);
      for (const r of (rows || [])) {
        console.log(`  ${r.username} (${r.role}, ${r.type})`);
      }
      resolve();
    });
  });

  // Check activity log
  await new Promise(resolve => {
    db.get('SELECT COUNT(*) as count FROM activity_log', [], (err, row) => {
      console.log(`\nActivity log entries: ${row?.count || 0}`);
      resolve();
    });
  });

  // Check ground truths
  await new Promise(resolve => {
    db.get('SELECT COUNT(*) as count FROM ground_truths WHERE deprecated = 0', [], (err, row) => {
      console.log(`Ground truths: ${row?.count || 0}`);
      resolve();
    });
  });

  // Check integrity baseline
  if (fs.existsSync(BASELINE_PATH)) {
    const stat = fs.statSync(BASELINE_PATH);
    const hoursAgo = Math.round((Date.now() - stat.mtimeMs) / 3600000);
    console.log(`\nIntegrity baseline: exists (${hoursAgo}h old)`);
  } else {
    console.log('\nIntegrity baseline: NOT FOUND');
  }

  // Check server process
  const { execSync } = require('child_process');
  try {
    const procs = execSync('pgrep -fl "node.*server.js"', { encoding: 'utf8' }).trim();
    console.log(`\nDarkhan process: RUNNING\n  ${procs}`);
  } catch (e) {
    console.log('\nDarkhan process: NOT RUNNING');
  }

  db.close();
  console.log('');
}

async function resetPassword() {
  await requireAuth('reset-password');
  console.log('=== Password Reset ===\n');

  const bcrypt = require('bcrypt');
  const secretsDb = openDb(SECRETS_PATH);
  const db = openDb(DB_PATH);

  // Show available users
  await new Promise(resolve => {
    db.all("SELECT id, username, role FROM users WHERE type = 'human'", [], (err, rows) => {
      console.log('Human users:');
      for (const r of (rows || [])) console.log(`  ${r.username} (${r.id})`);
      resolve();
    });
  });

  const username = await prompt('\nUsername to reset: ');
  const newPassword = await prompt('New password (min 8 chars): ', { hidden: true });

  if (newPassword.length < 8) {
    console.log('Password too short. Aborting.');
    db.close(); secretsDb.close();
    return;
  }

  // Look up user ID
  const user = await new Promise(resolve => {
    db.get('SELECT id FROM users WHERE username = ?', [username], (err, row) => resolve(row));
  });

  if (!user) {
    console.log(`User "${username}" not found. Aborting.`);
    db.close(); secretsDb.close();
    return;
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await new Promise(resolve => {
    secretsDb.run(
      'UPDATE credentials SET password_hash = ?, must_change_password = 1 WHERE user_id = ?',
      [hash, user.id],
      function (err) {
        if (err) console.error('Error:', err.message);
        else console.log(`\nPassword reset for ${username}. Rows affected: ${this.changes}`);
        console.log('must_change_password set — will be prompted on next login.');
        resolve();
      }
    );
  });

  logAction(db, 'break_glass_password_reset', { username, userId: user.id });
  console.log('Action logged to activity trail.\n');
  db.close(); secretsDb.close();
}

async function liftLockdown() {
  await requireAuth('lift-lockdown');
  console.log('=== Lift Lockdown ===\n');

  const db = openDb(DB_PATH);

  const newState = JSON.stringify({
    active: false,
    reason: null,
    triggeredBy: null,
    activatedAt: null,
    liftedBy: 'break_glass',
    liftedAt: new Date().toISOString(),
  });

  await new Promise(resolve => {
    db.run(
      "INSERT INTO settings (key, value) VALUES ('lockdown_state', ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP",
      [newState, newState],
      function (err) {
        if (err) console.error('Error:', err.message);
        else console.log('Lockdown lifted via break-glass.');
        resolve();
      }
    );
  });

  logAction(db, 'break_glass_lockdown_lifted', { method: 'break-glass.js' });
  console.log('Action logged. Restart Darkhan for workers to load.\n');
  db.close();
}

async function resetBaseline() {
  await requireAuth('reset-baseline');
  console.log('=== Reset Integrity Baseline ===\n');

  const db = openDb(DB_PATH);

  // Hash all critical files
  const criticalFiles = [
    'server.js', 'darkhan.config.json', 'middleware/auth.js',
    'services/security.js', 'services/integrity.js', 'services/auto-responder.js',
    'services/worker-runtime.js', 'services/llm.js', 'services/activity-log.js',
    'services/ground-truth.js', 'services/claim-verifier.js', 'services/sandbox.js',
    'routes/messages.js', 'routes/auth.js', 'routes/vault.js',
    'db/schema.sql', 'db/secrets-schema.sql', 'db/seed.js',
  ];

  const hashes = {};
  for (const file of criticalFiles) {
    const fullPath = path.join(SERVER_DIR, file);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath);
      hashes[file] = crypto.createHash('sha256').update(content).digest('hex');
      console.log(`  ${file}: ${hashes[file].substring(0, 16)}...`);
    }
  }

  // Count users
  const userCount = await new Promise(resolve => {
    db.get('SELECT COUNT(*) as count FROM users', [], (err, row) => resolve(row?.count || 0));
  });

  // Save external baseline
  const baseline = {
    hashes,
    userCount,
    createdAt: new Date().toISOString(),
    createdBy: 'break-glass.js (PIN-authenticated)',
  };

  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
  fs.chmodSync(BASELINE_PATH, 0o600);

  console.log(`\nBaseline saved: ${Object.keys(hashes).length} files, ${userCount} users`);
  console.log(`Location: ${BASELINE_PATH}`);

  logAction(db, 'break_glass_baseline_reset', { files: Object.keys(hashes).length, users: userCount });
  console.log('Action logged. Restart Darkhan for clean startup.\n');
  db.close();
}

// --- Main ---

const command = process.argv[2];
const commands = {
  'status': status,
  'reset-password': resetPassword,
  'lift-lockdown': liftLockdown,
  'reset-baseline': resetBaseline,
};

if (!command || !commands[command]) {
  console.log(`
Darkhan Break Glass Recovery Tool

Usage: node break-glass.js <command>

Commands:
  status           Show system state (no auth required — read only)
  reset-password   Reset a user's password (requires TTY + PIN)
  lift-lockdown    Force lift lockdown state (requires TTY + PIN)
  reset-baseline   Re-hash all files as new baseline (requires TTY + PIN)

SECURITY: Destructive commands require:
  1. An interactive terminal (TTY) — cannot run from scripts or agents
  2. Your lockdown PIN — verified against the credential store

This tool operates directly on Darkhan's databases.
Every action is logged to the immutable activity trail.
`);
  process.exit(0);
}

commands[command]().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
