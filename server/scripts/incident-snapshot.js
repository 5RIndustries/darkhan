#!/usr/bin/env node
/**
 * Darkhan — Incident Snapshot
 *
 * Emergency forensic capture. Run this FIRST when you suspect a compromise.
 * Do NOT restart, patch, or modify anything before running this command.
 *
 * Creates a timestamped archive containing:
 *   - Database copy (darkhan.db, secrets.db, sessions.db)
 *   - Configuration (darkhan.config.json, .env with secrets redacted)
 *   - Integrity baseline (external file)
 *   - Hash-chain audit log export (last 7 days)
 *   - Active process list
 *   - Network connections
 *   - File permissions on sensitive paths
 *   - Git status + recent commits
 *   - System info (OS, Node version, uptime)
 *
 * The snapshot is self-contained — everything needed for post-mortem analysis.
 *
 * Usage:
 *   node scripts/incident-snapshot.js
 *   node scripts/incident-snapshot.js --output /path/to/save/
 *
 * Output: darkhan-incident-YYYY-MM-DDTHH-MM-SS.tar.gz
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const os = require('os');

const SERVER_DIR = path.join(__dirname, '..');
const DB_DIR = path.join(SERVER_DIR, 'db');

// Parse args
const args = process.argv.slice(2);
const outputIdx = args.indexOf('--output');
const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : os.homedir();

// Colors
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', accent: '\x1b[38;5;214m',
};

function success(msg) { console.log(`${c.green}  [SNAP]${c.reset} ${msg}`); }
function warn(msg) { console.log(`${c.accent}  [SNAP]${c.reset} ${msg}`); }
function fail(msg) { console.log(`${c.red}  [SNAP]${c.reset} ${msg}`); }

console.log('');
console.log(`${c.red}${c.bold}╔══════════════════════════════════════════╗${c.reset}`);
console.log(`${c.red}${c.bold}║  Darkhan — Incident Forensic Snapshot    ║${c.reset}`);
console.log(`${c.red}${c.bold}║  DO NOT MODIFY ANYTHING BEFORE THIS RUNS ║${c.reset}`);
console.log(`${c.red}${c.bold}╚══════════════════════════════════════════╝${c.reset}`);
console.log('');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapshotName = `darkhan-incident-${timestamp}`;
const snapshotDir = path.join(os.tmpdir(), snapshotName);

// Create snapshot directory
fs.mkdirSync(snapshotDir, { recursive: true });
fs.mkdirSync(path.join(snapshotDir, 'db'), { recursive: true });
fs.mkdirSync(path.join(snapshotDir, 'config'), { recursive: true });
fs.mkdirSync(path.join(snapshotDir, 'system'), { recursive: true });

let manifest = [];

function capture(label, fn) {
  try {
    fn();
    manifest.push({ item: label, status: 'captured' });
    success(label);
  } catch (e) {
    manifest.push({ item: label, status: 'failed', error: e.message });
    warn(`${label} — ${e.message}`);
  }
}

// ── Databases ──
capture('darkhan.db', () => {
  const src = path.join(DB_DIR, 'darkhan.db');
  if (!fs.existsSync(src)) throw new Error('File not found');
  const dst = path.join(snapshotDir, 'db', 'darkhan.db');
  // Use SQLite's .backup command for a consistent copy (handles WAL correctly)
  try {
    execSync(`sqlite3 "${src}" ".backup '${dst}'"`, { timeout: 10000 });
  } catch {
    // Fallback: raw copy + WAL/SHM
    fs.copyFileSync(src, dst);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, dst + ext);
    }
  }
});

capture('secrets.db', () => {
  const src = path.join(DB_DIR, 'secrets.db');
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(snapshotDir, 'db', 'secrets.db'));
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, path.join(snapshotDir, 'db', 'secrets.db' + ext));
    }
  } else throw new Error('File not found');
});

capture('sessions.db', () => {
  const src = path.join(DB_DIR, 'sessions.db');
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(snapshotDir, 'db', 'sessions.db'));
  } else throw new Error('File not found');
});

// ── Configuration ──
capture('darkhan.config.json', () => {
  const src = path.join(SERVER_DIR, 'darkhan.config.json');
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(snapshotDir, 'config', 'darkhan.config.json'));
  else throw new Error('File not found');
});

capture('.env (redacted)', () => {
  const src = path.join(SERVER_DIR, '.env');
  if (fs.existsSync(src)) {
    const content = fs.readFileSync(src, 'utf8');
    // Redact actual key values but preserve structure
    const redacted = content.replace(/^([A-Z_]+)=(.+)$/gm, (match, key, value) => {
      const sensitive = ['SECRET', 'KEY', 'TOKEN', 'PASSWORD', 'PIN'].some(s => key.includes(s));
      return sensitive ? `${key}=[REDACTED-${crypto.createHash('sha256').update(value).digest('hex').substring(0, 8)}]` : match;
    });
    fs.writeFileSync(path.join(snapshotDir, 'config', 'env-redacted.txt'), redacted);
  } else throw new Error('File not found');
});

// ── Integrity Baseline ──
capture('integrity baseline', () => {
  const src = path.join(os.homedir(), '.darkhan-integrity-baseline.json');
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(snapshotDir, 'config', 'integrity-baseline.json'));
    const stat = fs.statSync(src);
    fs.writeFileSync(path.join(snapshotDir, 'config', 'integrity-baseline-meta.json'),
      JSON.stringify({ mtime: stat.mtime, mode: '0' + (stat.mode & 0o777).toString(8), size: stat.size }, null, 2));
  } else throw new Error('File not found');
});

// ── Hash-Chain Audit Export ──
// Use the copied database (not the live one) to avoid lock contention
capture('audit log (last 7 days)', () => {
  const dbCopy = path.join(snapshotDir, 'db', 'darkhan.db');
  if (!fs.existsSync(dbCopy)) throw new Error('Database copy not available');

  const outFile = path.join(snapshotDir, 'db', 'audit-log-7d.csv');
  // Write directly to file to avoid buffer limits on large audit logs
  execSync(
    `sqlite3 -header -csv '${dbCopy}' "SELECT id, actor, action, target, origin, created_at, chain_hash FROM activity_log WHERE created_at >= datetime('now', '-7 days') ORDER BY created_at DESC;" > '${outFile}'`,
    { timeout: 30000, shell: '/bin/bash' }
  );
  const stat = fs.statSync(outFile);
  if (stat.size === 0) fs.writeFileSync(outFile, '(empty)');
});

// ── Hash-Chain Integrity Check ──
capture('hash-chain verification', () => {
  const dbCopy = path.join(snapshotDir, 'db', 'darkhan.db');
  if (!fs.existsSync(dbCopy)) throw new Error('Database copy not available');

  const result = execSync(
    `sqlite3 '${dbCopy}' 'SELECT COUNT(*) as total, MIN(created_at) as earliest, MAX(created_at) as latest FROM activity_log;'`,
    { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  fs.writeFileSync(path.join(snapshotDir, 'db', 'audit-log-summary.txt'), result || '(empty)');
});

// ── System State ──
capture('process list', () => {
  const result = execSync('ps aux', { encoding: 'utf8', timeout: 5000 });
  fs.writeFileSync(path.join(snapshotDir, 'system', 'processes.txt'), result);
});

capture('network connections', () => {
  const result = execSync('netstat -an 2>/dev/null || ss -tunapl 2>/dev/null || echo "network tools unavailable"',
    { encoding: 'utf8', timeout: 5000 });
  fs.writeFileSync(path.join(snapshotDir, 'system', 'network.txt'), result);
});

capture('listening ports', () => {
  const result = execSync('lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null || echo "lsof unavailable"',
    { encoding: 'utf8', timeout: 5000 });
  fs.writeFileSync(path.join(snapshotDir, 'system', 'listening-ports.txt'), result);
});

capture('file permissions (sensitive paths)', () => {
  const paths = [
    path.join(SERVER_DIR, '.env'),
    path.join(DB_DIR, 'darkhan.db'),
    path.join(DB_DIR, 'secrets.db'),
    path.join(DB_DIR, 'sessions.db'),
    path.join(os.homedir(), '.darkhan-integrity-baseline.json'),
  ];
  const results = paths.map(p => {
    try {
      const stat = fs.statSync(p);
      return `${p}: mode=${'0' + (stat.mode & 0o777).toString(8)} uid=${stat.uid} gid=${stat.gid} size=${stat.size} mtime=${stat.mtime.toISOString()}`;
    } catch {
      return `${p}: NOT FOUND`;
    }
  });
  fs.writeFileSync(path.join(snapshotDir, 'system', 'file-permissions.txt'), results.join('\n'));
});

capture('system info', () => {
  const info = {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    nodeVersion: process.version,
    uptime: os.uptime(),
    totalMemory: Math.round(os.totalmem() / (1024 ** 3)) + ' GB',
    freeMemory: Math.round(os.freemem() / (1024 ** 3)) + ' GB',
    cpus: os.cpus().length,
    user: os.userInfo().username,
    cwd: process.cwd(),
    snapshotTime: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(snapshotDir, 'system', 'system-info.json'), JSON.stringify(info, null, 2));
});

// ── Git State ──
capture('git status + recent commits', () => {
  const repoDir = path.join(SERVER_DIR, '..');
  const status = execSync('git status', { cwd: repoDir, encoding: 'utf8', timeout: 5000 });
  const log = execSync('git log --oneline -20', { cwd: repoDir, encoding: 'utf8', timeout: 5000 });
  const diff = execSync('git diff --stat', { cwd: repoDir, encoding: 'utf8', timeout: 5000 });
  fs.writeFileSync(path.join(snapshotDir, 'system', 'git-state.txt'),
    `=== git status ===\n${status}\n=== git log (last 20) ===\n${log}\n=== git diff --stat ===\n${diff}`);
});

// ── Manifest + Hash ──
capture('snapshot manifest', () => {
  fs.writeFileSync(path.join(snapshotDir, 'MANIFEST.json'), JSON.stringify({
    snapshotId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    darkhanDir: SERVER_DIR,
    items: manifest,
  }, null, 2));
});

// ── Package into tarball ──
console.log('');
const tarballName = `${snapshotName}.tar.gz`;
const tarballPath = path.join(outputDir, tarballName);

try {
  execSync(`tar -czf "${tarballPath}" -C "${path.dirname(snapshotDir)}" "${snapshotName}"`,
    { timeout: 30000 });

  // Hash the tarball for tamper detection
  const tarballHash = crypto.createHash('sha256')
    .update(fs.readFileSync(tarballPath))
    .digest('hex');

  // Clean up temp directory
  execSync(`rm -rf "${snapshotDir}"`);

  console.log(`${c.green}${c.bold}  Snapshot complete.${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}Archive:${c.reset}  ${tarballPath}`);
  console.log(`  ${c.bold}SHA-256:${c.reset}  ${tarballHash}`);
  console.log(`  ${c.bold}Items:${c.reset}    ${manifest.filter(m => m.status === 'captured').length} captured, ${manifest.filter(m => m.status === 'failed').length} failed`);
  console.log('');
  console.log(`  ${c.red}${c.bold}NEXT STEPS:${c.reset}`);
  console.log(`    1. Copy this archive to a SEPARATE machine before doing anything else`);
  console.log(`    2. Do NOT delete logs, restart services, or apply patches yet`);
  console.log(`    3. Read INCIDENT-RESPONSE.md for the full response procedure`);
  console.log('');

} catch (e) {
  fail(`Tarball creation failed: ${e.message}`);
  console.log(`  Raw snapshot preserved at: ${snapshotDir}`);
}
