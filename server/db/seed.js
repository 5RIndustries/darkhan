#!/usr/bin/env node
/**
 * Darkhan — Database Seed Script
 * Creates team members (humans + agents) from darkhan.config.json.
 * Idempotent: safe to re-run (INSERT OR IGNORE).
 */

const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'darkhan.db');
const SECRETS_DB_PATH = path.join(__dirname, 'secrets.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const SECRETS_SCHEMA_PATH = path.join(__dirname, 'secrets-schema.sql');
const CONFIG_PATH = path.join(__dirname, '..', 'darkhan.config.json');

function generateApiKey(prefix = 'dk') {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

async function seed() {
  console.log('\n=== Darkhan Seed Script ===\n');

  // Load config
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    console.log(`✓ Config loaded: ${config.instance?.brandName || 'Darkhan'}`);
  } catch (e) {
    console.error(`✗ Failed to load config from ${CONFIG_PATH}:`, e.message);
    process.exit(1);
  }

  const db = new sqlite3.Database(DB_PATH);
  const secretsDb = new sqlite3.Database(SECRETS_DB_PATH);

  const run = (sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    }));
  const get = (sql, params = []) =>
    new Promise((resolve, reject) => db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    }));
  const secretsRun = (sql, params = []) =>
    new Promise((resolve, reject) => secretsDb.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    }));
  const secretsGet = (sql, params = []) =>
    new Promise((resolve, reject) => secretsDb.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    }));

  // Apply schemas (CREATE IF NOT EXISTS is safe to re-run)
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await new Promise((resolve, reject) => {
    db.exec(schema, (err) => { if (err) reject(err); else resolve(); });
  });
  console.log('✓ Main schema applied.');

  const secretsSchema = fs.readFileSync(SECRETS_SCHEMA_PATH, 'utf8');
  await new Promise((resolve, reject) => {
    secretsDb.exec(secretsSchema, (err) => { if (err) reject(err); else resolve(); });
  });
  console.log('✓ Secrets schema applied.');

  // Set secrets.db permissions to 600 (owner-only)
  try {
    fs.chmodSync(SECRETS_DB_PATH, 0o600);
    console.log('✓ secrets.db permissions set to 600');
  } catch (e) {
    console.warn('⚠ Could not set secrets.db permissions:', e.message);
  }

  // Seed channels from config
  const channels = config.channels || [];
  for (const ch of channels) {
    await run(
      'INSERT OR IGNORE INTO channels (id, name, description) VALUES (?, ?, ?)',
      [ch.id, ch.name, ch.description || '']
    );
  }
  console.log(`✓ ${channels.length} channel(s) seeded.`);

  // Seed team members from config
  const members = config.team?.members || [];
  const newKeys = {};

  for (const member of members) {
    const exists = await get('SELECT id FROM users WHERE id = ?', [member.id]);
    if (exists) {
      await run(
        'UPDATE users SET display_name = ?, type = ?, role = ? WHERE id = ?',
        [member.name, member.type, member.role, member.id]
      );
      console.log(`✓ ${member.name} (${member.id}) updated.`);
      continue;
    }

    let passwordHash, apiKey;

    if (member.type === 'human') {
      // SECURITY: Generate a random temporary password — never use a hardcoded default.
      // This password is printed to stdout ONCE. It must be changed via the web UI Settings.
      const defaultPw = crypto.randomBytes(16).toString('hex');
      passwordHash = await bcrypt.hash(defaultPw, 12);
      apiKey = generateApiKey('dk_user');
      console.log('\n' + '='.repeat(60));
      console.log('⚠  WARNING: TEMPORARY PASSWORD — CHANGE IMMEDIATELY');
      console.log(`   User: ${member.name} (${member.id})`);
      console.log(`   Password: ${defaultPw}`);
      console.log('   Change this password via the Darkhan web UI Settings.');
      console.log('   This password will NOT be displayed again.');
      console.log('='.repeat(60) + '\n');
    } else {
      passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      apiKey = generateApiKey('dk_agent');
      console.log(`✓ Agent "${member.name}" created.`);
    }

    // Write non-sensitive user data to main darkhan.db
    // SECURITY: password_hash and api_key are NEVER written here — secrets.db only
    await run(
      `INSERT OR IGNORE INTO users (id, username, role, type, display_name, notification_prefs)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [member.id, member.name.toLowerCase(), member.role, member.type,
       member.name, member.notifications ? JSON.stringify(member.notifications) : null]
    );

    // Write credentials to secrets.db (credential-isolated database)
    // Human users must change their temporary password on first login.
    const mustChangePassword = member.type === 'human' ? 1 : 0;
    await secretsRun(
      `INSERT OR IGNORE INTO credentials (user_id, password_hash, api_key, must_change_password)
       VALUES (?, ?, ?, ?)`,
      [member.id, passwordHash, apiKey, mustChangePassword]
    );

    newKeys[member.id] = apiKey;
  }

  if (Object.keys(newKeys).length > 0) {
    console.log('\n--- New API Keys (save these!) ---');
    for (const [id, key] of Object.entries(newKeys)) {
      console.log(`  ${id}: ${key}`);
    }
    console.log('---');
  }

  console.log(`\n=== Seed Complete (${members.length} team members) ===\n`);
  db.close();
  secretsDb.close();
}

seed().catch((err) => { console.error('Seed failed:', err); process.exit(1); });
