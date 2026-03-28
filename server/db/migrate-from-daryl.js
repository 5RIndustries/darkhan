#!/usr/bin/env node
/**
 * Darkhan — DARYL Migration Script
 *
 * Imports message history from DARYL's database into Darkhan.
 * Preserves all messages with original timestamps and users.
 * Safe to re-run (INSERT OR IGNORE).
 *
 * Usage: node server/db/migrate-from-daryl.js [path-to-daryl.db]
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DARYL_DB = process.argv[2] || path.join(__dirname, '../../../DARYL-migrate/server/db/daryl.db');
const DARKHAN_DB = path.join(__dirname, 'darkhan.db');

async function migrate() {
  console.log('\n=== Darkhan Migration from DARYL ===\n');
  console.log(`Source: ${DARYL_DB}`);
  console.log(`Target: ${DARKHAN_DB}\n`);

  const daryl = new sqlite3.Database(DARYL_DB, sqlite3.OPEN_READONLY);
  const darkhan = new sqlite3.Database(DARKHAN_DB);

  const darylAll = (sql, params = []) =>
    new Promise((resolve, reject) => daryl.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows || []);
    }));

  const darkhanRun = (sql, params = []) =>
    new Promise((resolve, reject) => darkhan.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    }));

  // Migrate messages
  console.log('Migrating messages...');
  const messages = await darylAll('SELECT * FROM messages ORDER BY created_at ASC');
  let imported = 0;
  let skipped = 0;

  for (const msg of messages) {
    try {
      await darkhanRun(
        `INSERT OR IGNORE INTO messages (id, channel_id, from_user, body, priority, type, reply_to, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [msg.id, msg.channel_id, msg.from_user, msg.body, msg.priority || 'normal',
         msg.type || 'message', msg.reply_to, msg.metadata, msg.created_at]
      );
      imported++;
    } catch (e) {
      skipped++;
    }
  }
  console.log(`✓ Messages: ${imported} imported, ${skipped} skipped (duplicates)`);

  // Migrate tasks
  const tasks = await darylAll('SELECT * FROM tasks ORDER BY created_at ASC');
  let tasksImported = 0;
  for (const task of tasks) {
    try {
      await darkhanRun(
        `INSERT OR IGNORE INTO tasks (id, title, description, assignee, created_by, status, priority, vault_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [task.id, task.title, task.description, task.assignee, task.created_by,
         task.status, task.priority, task.vault_path, task.created_at, task.updated_at]
      );
      tasksImported++;
    } catch (e) { /* skip */ }
  }
  console.log(`✓ Tasks: ${tasksImported} imported`);

  // Migrate heartbeats
  const heartbeats = await darylAll('SELECT * FROM agent_heartbeats');
  for (const hb of heartbeats) {
    try {
      await darkhanRun(
        `INSERT OR IGNORE INTO agent_heartbeats (agent, status, last_ping_at, last_message_at)
         VALUES (?, ?, ?, ?)`,
        [hb.agent, hb.status, hb.last_ping_at, hb.last_message_at]
      );
    } catch (e) { /* skip */ }
  }
  console.log(`✓ Heartbeats: ${heartbeats.length} imported`);

  // Migrate Claude conversations
  try {
    const convos = await darylAll('SELECT * FROM claude_conversations ORDER BY created_at ASC');
    for (const c of convos) {
      await darkhanRun(
        `INSERT OR IGNORE INTO claude_conversations (id, channel_id, role, content, tool_use, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.channel_id, c.role, c.content, c.tool_use, c.token_count, c.created_at]
      );
    }
    console.log(`✓ Claude conversations: ${convos.length} imported`);
  } catch (e) {
    console.log('✓ Claude conversations: skipped (table may not exist in source)');
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`Total: ${imported} messages, ${tasksImported} tasks imported\n`);

  daryl.close();
  darkhan.close();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
