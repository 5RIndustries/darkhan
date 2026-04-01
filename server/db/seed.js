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
const SecretsCrypto = require('../services/secrets-crypto');

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

  // Run migrations (ALTER TABLE) with error handling — these may already exist on fresh installs
  const migrations = [
    'ALTER TABLE credentials ADD COLUMN must_change_password INTEGER DEFAULT 1',
    'ALTER TABLE credentials ADD COLUMN api_key_hmac TEXT',
  ];
  for (const sql of migrations) {
    try { await secretsRun(sql); } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
      // Column already exists — expected on fresh install where CREATE TABLE included it
    }
  }
  // Ensure HMAC index exists
  try { await secretsRun('CREATE INDEX IF NOT EXISTS idx_credentials_api_key_hmac ON credentials(api_key_hmac)'); } catch {}

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
      // If running from setup wizard, use the password the user chose.
      // Otherwise, generate a random temporary password.
      const setupPassword = process.env.DARKHAN_SETUP_PASSWORD;
      const defaultPw = setupPassword || crypto.randomBytes(16).toString('hex');
      passwordHash = await bcrypt.hash(defaultPw, 12);
      apiKey = generateApiKey('dk_user');
      if (!setupPassword) {
        console.log('\n' + '='.repeat(60));
        console.log('  TEMPORARY PASSWORD — CHANGE IMMEDIATELY');
        console.log(`   User: ${member.name} (${member.id})`);
        console.log(`   Login username: ${member.name.toLowerCase()}`);
        console.log(`   Password: ${defaultPw}`);
        console.log('   Change this password via the Darkhan web UI Settings.');
        console.log('   This password will NOT be displayed again.');
        console.log('='.repeat(60) + '\n');
      } else {
        console.log(`✓ Admin "${member.name}" created with your chosen password.`);
        console.log(`   Login username: ${member.name.toLowerCase()}`);
      }
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

  // Encrypt API keys at rest if SESSION_SECRET is available
  const sessionSecret = process.env.SESSION_SECRET;
  if (sessionSecret) {
    const secretsCrypto = new SecretsCrypto(sessionSecret);
    console.log('\n✓ Encrypting API keys at rest...');
    const allCreds = await new Promise((resolve, reject) =>
      secretsDb.all('SELECT user_id, api_key FROM credentials', [], (err, rows) => {
        if (err) reject(err); else resolve(rows);
      }));
    for (const cred of allCreds) {
      if (cred.api_key && !secretsCrypto.isEncrypted(cred.api_key)) {
        const encrypted = secretsCrypto.encrypt(cred.api_key);
        const hmac = secretsCrypto.hmac(cred.api_key);
        await secretsRun(
          'UPDATE credentials SET api_key = ?, api_key_hmac = ? WHERE user_id = ?',
          [encrypted, hmac, cred.user_id]
        );
      }
    }
    console.log(`✓ ${allCreds.length} API key(s) encrypted.`);
  } else {
    console.log('\n⚠ SESSION_SECRET not set — API keys stored unencrypted.');
    console.log('  Set SESSION_SECRET in .env and re-run seed to encrypt.');
  }

  if (Object.keys(newKeys).length > 0) {
    console.log('\n--- New API Keys (save these!) ---');
    for (const [id, key] of Object.entries(newKeys)) {
      console.log(`  ${id}: ${key}`);
    }
    console.log('---');
  }

  // Set lockdown PIN if provided by setup wizard
  const setupPin = process.env.DARKHAN_SETUP_PIN;
  if (setupPin) {
    const pinHash = await bcrypt.hash(setupPin, 12);
    await secretsRun(
      `INSERT OR REPLACE INTO secret_settings (key, value) VALUES ('lockdown_pin', ?)`,
      [pinHash]
    );
    console.log('✓ Lockdown PIN configured.');
  }

  console.log(`\n=== Seed Complete (${members.length} team members) ===\n`);
  db.close();
  secretsDb.close();
}

seed().catch((err) => { console.error('Seed failed:', err); process.exit(1); });
