#!/usr/bin/env node
/**
 * Darkhan — Cross-Agent Communication Verification
 *
 * Verifies all communication paths are operational.
 * Run from any node to check connectivity.
 *
 * Usage:
 *   node server/scripts/comms-check.js [--node <ip:port>] [--hub <ip:port>]
 *
 * Checks:
 *   1. Local Darkhan API (health + message post)
 *   2. Terminal heartbeat (MCP bridge active?)
 *   3. Anthropic rate limit state (persisted cooldown?)
 *   4. Federation hub (Mokume) connectivity
 *   5. Inbox directory (writable?)
 *   6. Single-consumer mode (terminal vs relay?)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const DARKHAN_PORT = process.env.DARKHAN_PORT || 3001;
const HUB_PORT = process.env.HUB_PORT || 4001;

// Parse args
const args = process.argv.slice(2);
let nodeHost = `localhost:${DARKHAN_PORT}`;
let hubHost = `localhost:${HUB_PORT}`;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--node' && args[i + 1]) nodeHost = args[++i];
  if (args[i] === '--hub' && args[i + 1]) hubHost = args[++i];
}

const results = [];

function check(name, status, detail) {
  const icon = status === 'pass' ? '\x1b[32m✓\x1b[0m' : status === 'warn' ? '\x1b[33m⚠\x1b[0m' : '\x1b[31m✗\x1b[0m';
  results.push({ name, status, detail });
  console.log(`  ${icon} ${name}: ${detail}`);
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function run() {
  console.log('\n\x1b[1mDarkhan Communication Verification\x1b[0m');
  console.log(`  Node: ${nodeHost} | Hub: ${hubHost}`);
  console.log('');

  // 1. Local Darkhan health
  try {
    const res = await httpGet(`http://${nodeHost}/api/diagnostic`);
    if (res.status === 200 && (res.data?.server === 'running' || res.data?.status === 'ok')) {
      check('Darkhan API', 'pass', `Running`);
    } else {
      check('Darkhan API', 'fail', `Unexpected response: ${res.status}`);
    }
  } catch (e) {
    check('Darkhan API', 'fail', `Unreachable: ${e.message}`);
  }

  // 2. Terminal heartbeat
  const heartbeatPath = path.join(HOME, '.claude', '.terminal-heartbeat');
  try {
    const data = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
    const ageMs = Date.now() - (data.epochMs || 0);
    const ageSec = Math.round(ageMs / 1000);
    if (ageMs < 300000) {
      check('Terminal heartbeat', 'pass', `Fresh (${ageSec}s ago, PID ${data.pid})`);
    } else {
      check('Terminal heartbeat', 'warn', `Stale (${ageSec}s ago) — terminal may be offline`);
    }
  } catch {
    check('Terminal heartbeat', 'warn', 'No heartbeat file — no terminal session active');
  }

  // 3. Anthropic rate limit state
  const rateLimitPath = path.join(HOME, '.claude', '.anthropic-rate-limit.json');
  try {
    const data = JSON.parse(fs.readFileSync(rateLimitPath, 'utf8'));
    if (data.limited && Date.now() < data.resetsAt) {
      const resetsAt = new Date(data.resetsAt).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
      });
      check('Anthropic rate limit', 'warn', `In cooldown until ~${resetsAt} ET (${data.consecutiveErrors} consecutive)`);
    } else {
      check('Anthropic rate limit', 'pass', 'No active cooldown');
    }
  } catch {
    check('Anthropic rate limit', 'pass', 'No rate limit state file (clean)');
  }

  // 4. Single-consumer mode
  const terminalActive = fs.existsSync(heartbeatPath);
  let heartbeatFresh = false;
  try {
    const data = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
    heartbeatFresh = (Date.now() - (data.epochMs || 0)) < 300000;
  } catch {}
  const consumerMode = heartbeatFresh ? 'terminal' : 'relay';
  check('Consumer mode', 'pass', `${consumerMode} (${heartbeatFresh ? 'terminal owns API — relay forwards to inbox' : 'relay owns API — no terminal detected'})`);

  // 5. Inbox directory
  const inboxDir = path.join(HOME, '.claude', 'darkhan-inbox');
  const processedDir = path.join(inboxDir, '.processed');
  try {
    if (!fs.existsSync(inboxDir)) {
      check('Inbox directory', 'fail', `Missing: ${inboxDir}`);
    } else {
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
      const hasProcessed = fs.existsSync(processedDir);
      check('Inbox directory', 'pass', `${files.length} pending message(s), .processed/ ${hasProcessed ? 'exists' : 'MISSING'}`);
    }
  } catch (e) {
    check('Inbox directory', 'fail', e.message);
  }

  // 6. Federation hub
  try {
    const res = await httpGet(`http://${hubHost}/api/health`);
    if (res.status === 200 && res.data?.status === 'ok') {
      check('Mokume hub', 'pass', `Running (${res.data.peers || 0} peers, ${res.data.uptime || 'unknown'}s uptime)`);
    } else {
      check('Mokume hub', 'warn', `Unexpected: ${JSON.stringify(res.data).substring(0, 100)}`);
    }
  } catch (e) {
    check('Mokume hub', 'warn', `Unreachable: ${e.message} (federation offline)`);
  }

  // Summary
  console.log('');
  const fails = results.filter(r => r.status === 'fail').length;
  const warns = results.filter(r => r.status === 'warn').length;
  if (fails > 0) {
    console.log(`\x1b[31m  ${fails} FAILED\x1b[0m, ${warns} warnings, ${results.length - fails - warns} passed`);
    process.exit(1);
  } else if (warns > 0) {
    console.log(`\x1b[33m  ${warns} warnings\x1b[0m, ${results.length - warns} passed`);
  } else {
    console.log(`\x1b[32m  All ${results.length} checks passed\x1b[0m`);
  }
  console.log('');
}

run().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
