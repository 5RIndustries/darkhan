#!/usr/bin/env node
/**
 * Darkhan — Break Glass Recovery Tool
 *
 * Emergency admin recovery when you're locked out of the web UI.
 * This script runs OUTSIDE of Darkhan's security stack — it operates
 * directly on the database files.
 *
 * USE CASES:
 *   1. Forgot password → reset it
 *   2. Lockdown won't lift → force lift + reset baseline
 *   3. Integrity baseline stale after code changes → reset baseline
 *   4. Need to verify system state without starting Darkhan
 *
 * SECURITY:
 *   - Requires shell access as the Darkhan user (same as running the server)
 *   - Every action is logged to the activity log with "break_glass" actor
 *   - This script CANNOT be run from within Darkhan (it's not a route/endpoint)
 *   - It is a deliberate escape hatch — the admin always retains control
 *
 * USAGE:
 *   node break-glass.js reset-password
 *   node break-glass.js lift-lockdown
 *   node break-glass.js reset-baseline
 *   node break-glass.js status
 */

const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SERVER_DIR = __dirname;
const DB_PATH = path.join(SERVER_DIR, 'db', 'darkhan.db');
const SECRETS_PATH = path.join(SERVER_DIR, 'db', 'secrets.db');
const BASELINE_PATH = path.join(process.env.HOME, '.darkhan-integrity-baseline.json');

function openDb(dbPath) {
  const sqlite3 = require('sqlite3').verbose();
  return new sqlite3.Database(dbPath);
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
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
  console.log('\n=== Password Reset ===\n');

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
  const newPassword = await prompt('New password (min 8 chars): ');

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
  console.log('\n=== Lift Lockdown ===\n');

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
  console.log('\n=== Reset Integrity Baseline ===\n');

  const db = openDb(DB_PATH);

  // Hash all critical files
  const criticalFiles = [
    'server.js', 'darkhan.config.json', 'middleware/auth.js',
    'services/security.js', 'services/integrity.js', 'services/auto-responder.js',
    'services/worker-runtime.js', 'services/llm.js', 'services/activity-log.js',
    'services/ground-truth.js', 'services/claim-verifier.js',
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
    createdBy: 'break-glass.js',
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
  status           Show system state (lockdown, users, processes)
  reset-password   Reset a user's password
  lift-lockdown    Force lift lockdown state
  reset-baseline   Re-hash all files and save as new integrity baseline

This tool operates directly on Darkhan's databases.
Every action is logged to the immutable activity trail.
`);
  process.exit(0);
}

commands[command]().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
