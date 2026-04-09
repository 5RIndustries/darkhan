#!/usr/bin/env node
/**
 * Darkhan MCP Server — Push Notification Bridge
 *
 * Always-on bridge between Darkhan workspace and Claude Code CLI.
 * Connects to local Darkhan via Socket.IO and PUSHES incoming messages
 * to Claude Code via MCP logging notifications — no polling needed.
 *
 * Also exposes tools for reading history and posting messages.
 *
 * Registered in ~/.claude/settings.json under mcpServers.
 * Claude Code auto-starts this as a child process.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { io } from 'socket.io-client';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const DARKHAN_URL = process.env.DARKHAN_URL || 'http://localhost:3001';
const API_KEY = process.env.DARKHAN_API_KEY || '';
const CHANNELS = (process.env.DARKHAN_CHANNELS || 'chan_coordination,chan_alerts').split(',');
const AGENT_ID = process.env.DARKHAN_AGENT_ID || 'agent_claude';

// Track connection state
let socketConnected = false;
let serverConnected = false;

// Terminal heartbeat — signals to the Darkhan relay that a standalone
// Claude Code terminal is active, so the relay should forward messages
// here instead of spawning competing SDK sessions on the same Max plan.
const HEARTBEAT_PATH = path.join(os.homedir(), '.claude', '.terminal-heartbeat');
const HEARTBEAT_TMP = HEARTBEAT_PATH + '.tmp';
const HEARTBEAT_INTERVAL_MS = 30000;

// Discover parent Claude Code's TTY at startup (one-time)
import { execSync } from 'child_process';
let parentTty = null;
try {
  const raw = execSync(`ps -p ${process.ppid} -o tty=`, { encoding: 'utf8' }).trim();
  if (raw && raw !== '??' && raw !== '-') {
    parentTty = `/dev/${raw}`;
  }
} catch { /* non-fatal — TTY discovery failed */ }

// Track when last prompt was received (updated by tool calls)
let lastPromptEpochMs = Date.now();

function writeHeartbeat() {
  try {
    const data = JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      agentId: AGENT_ID,
      timestamp: new Date().toISOString(),
      epochMs: Date.now(),
      lastPromptEpochMs,
      tty: parentTty,
    });
    // Atomic write: temp file + rename (prevents Sentinel reading partial JSON)
    fs.writeFileSync(HEARTBEAT_TMP, data);
    fs.renameSync(HEARTBEAT_TMP, HEARTBEAT_PATH);
  } catch { /* non-fatal */ }
}

// Write immediately on startup, then every 30s
writeHeartbeat();
const heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);

// Clean up heartbeat on exit so relay knows terminal is gone
function clearHeartbeat() {
  try { fs.unlinkSync(HEARTBEAT_PATH); } catch { /* already gone */ }
  clearInterval(heartbeatTimer);
}
process.on('exit', clearHeartbeat);
process.on('SIGINT', () => { clearHeartbeat(); process.exit(0); });
process.on('SIGTERM', () => { clearHeartbeat(); process.exit(0); });

// Create MCP server
const mcp = new McpServer({
  name: 'darkhan',
  version: '1.0.0',
});

// Enable logging capability on the underlying server
mcp.server.registerCapabilities({ logging: {} });

// --- Socket.IO connection to Darkhan ---

const socket = io(DARKHAN_URL, {
  reconnection: true,
  reconnectionDelay: 3000,
  reconnectionAttempts: Infinity,
  timeout: 10000,
  auth: { apiKey: API_KEY },
});

socket.on('connect', () => {
  socketConnected = true;
  for (const ch of CHANNELS) {
    socket.emit('join_channel', ch);
  }
});

socket.on('disconnect', (reason) => {
  socketConnected = false;
  // If server shut down, Socket.IO will auto-reconnect.
  // Log but don't crash.
});

socket.on('connect_error', (err) => {
  // Silent — Socket.IO handles retry. Don't crash the MCP server.
  socketConnected = false;
});

socket.on('error', (err) => {
  // Catch any Socket.IO errors that could crash the process
  socketConnected = false;
});

// Global error handlers — prevent MCP server from crashing on unhandled errors.
// The MCP server MUST stay alive for Claude Code's tool calls to work.
// Socket.IO reconnects handle Darkhan restarts; these catch everything else.
process.on('uncaughtException', (err) => {
  // Log to sentinel log if available, otherwise stderr
  try {
    const logPath = path.join(os.homedir(), '.claude', 'sentinel.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] MCP uncaughtException: ${err.message}\n`);
  } catch {}
  // Don't exit — keep the MCP server alive
});

process.on('unhandledRejection', (reason) => {
  try {
    const logPath = path.join(os.homedir(), '.claude', 'sentinel.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] MCP unhandledRejection: ${reason}\n`);
  } catch {}
  // Don't exit — keep the MCP server alive
});

// Dedup: track recent message bodies to prevent federation/relay duplicates
const recentMessageHashes = new Map(); // hash -> timestamp
const DEDUP_WINDOW_MS = 30000; // 30s dedup window

function messageHash(msg) {
  const key = `${msg.from_user}:${(msg.body || '').substring(0, 200)}`;
  return require('crypto').createHash('md5').update(key).digest('hex');
}

function isDuplicate(msg) {
  const hash = messageHash(msg);
  const now = Date.now();
  // Clean old entries
  for (const [k, ts] of recentMessageHashes) {
    if (now - ts > DEDUP_WINDOW_MS) recentMessageHashes.delete(k);
  }
  if (recentMessageHashes.has(hash)) return true;
  recentMessageHashes.set(hash, now);
  return false;
}

// Push incoming messages to Claude Code as logging notifications
socket.on('new_message', async (msg) => {
  if (!serverConnected) return;

  // Skip messages from ourselves to avoid echo
  if (msg.from_user === AGENT_ID) return;

  // Skip notification-type messages (system echoes)
  if (msg.type === 'notification') return;

  // Only push messages from channels we're watching
  if (!CHANNELS.includes(msg.channel_id)) return;

  // Skip Darkhan relay noise
  const body = msg.body || '';
  if (body === '...thinking' || body.includes('forwarded to active Claude Code terminal')) return;

  // Deduplicate — same sender + body within 30s window (catches federation/relay doubles)
  if (isDuplicate(msg)) return;

  // Determine priority — human messages and @claude mentions are critical
  const isHuman = msg.from_user?.startsWith('user_');
  const isMention = body.toLowerCase().includes('claude') ||
                    body.toLowerCase().includes('cos');
  const level = (isHuman || isMention) ? 'warning' : 'info';

  // Write to file-based inbox (persistent, survives MCP transport issues)
  const inboxDir = path.join(os.homedir(), '.claude', 'darkhan-inbox');
  try {
    if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
    const ts = msg.created_at || new Date().toISOString();
    const filename = `${ts.replace(/[:.]/g, '-')}_${msg.id || Date.now()}.json`;
    fs.writeFileSync(path.join(inboxDir, filename), JSON.stringify({
      from_user: msg.from_user,
      channel_id: msg.channel_id,
      body: msg.body,
      timestamp: ts,
      level,
    }, null, 2));
  } catch {
    // Inbox write failed — non-fatal
  }

  // Also push via MCP logging (real-time if Claude Code is listening)
  try {
    await mcp.server.sendLoggingMessage({
      level,
      logger: `darkhan:${msg.channel_id}`,
      data: {
        type: 'darkhan_message',
        from_user: msg.from_user,
        channel_id: msg.channel_id,
        body: msg.body,
        message_id: msg.id,
        timestamp: msg.created_at || new Date().toISOString(),
        formatted: `[Darkhan ${msg.channel_id}] ${msg.from_user}: ${msg.body}`,
      },
    });
  } catch {
    // Server not ready — non-fatal
  }
});

// --- HTTP helper for Darkhan API ---

function darkhanRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, DARKHAN_URL);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// --- Tools ---

// Update prompt timestamp on every tool call (proxy for "Claude is active")
function touchPromptTime() { lastPromptEpochMs = Date.now(); writeHeartbeat(); }

// Drain the file-based inbox (persistent notifications)
mcp.tool(
  'darkhan_drain_inbox',
  'Read and clear pending Darkhan notifications from the file inbox. Call this at session start and periodically.',
  {},
  async () => {
    touchPromptTime();
    const inboxDir = path.join(os.homedir(), '.claude', 'darkhan-inbox');
    try {
      if (!fs.existsSync(inboxDir)) return { content: [{ type: 'text', text: 'No inbox messages.' }] };
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json')).sort();
      if (files.length === 0) return { content: [{ type: 'text', text: 'No inbox messages.' }] };

      const messages = [];
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8'));
          messages.push(`[${data.timestamp}] ${data.from_user} in ${data.channel_id}: ${data.body}`);
          fs.unlinkSync(path.join(inboxDir, f)); // Clear after reading
        } catch { /* skip corrupt files */ }
      }
      return { content: [{ type: 'text', text: messages.join('\n\n') || 'No inbox messages.' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed: ${err.message}` }] };
    }
  }
);

// Check for pending/recent messages
mcp.tool(
  'darkhan_check_messages',
  'Check recent messages in Darkhan coordination channels',
  {
    channel_id: z.string().optional().describe('Channel to check (default: chan_coordination)'),
    limit: z.number().optional().describe('Number of messages (default 10)'),
  },
  async ({ channel_id, limit }) => {
    touchPromptTime();
    try {
      const ch = channel_id || 'chan_coordination';
      const n = limit || 10;
      const result = await darkhanRequest('GET', `/api/messages?channel_id=${ch}&limit=${n}`);
      const messages = result.messages || result;
      if (!Array.isArray(messages) || messages.length === 0) {
        return { content: [{ type: 'text', text: 'No recent messages.' }] };
      }
      const formatted = messages.map(m =>
        `[${m.created_at}] ${m.from_user}: ${m.body}`
      ).join('\n\n');
      return { content: [{ type: 'text', text: formatted }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed: ${err.message}` }] };
    }
  }
);

// Post a message to a channel
mcp.tool(
  'darkhan_post_message',
  'Post a message to a Darkhan channel (federates via Mokume to other nodes)',
  {
    channel_id: z.string().describe('Channel ID (e.g. chan_coordination, chan_alerts)'),
    body: z.string().describe('Message body'),
  },
  async ({ channel_id, body }) => {
    touchPromptTime();
    try {
      const result = await darkhanRequest('POST', '/api/messages', { channel_id, body });
      if (result.id || result.ok) {
        return { content: [{ type: 'text', text: `Posted to ${channel_id}` }] };
      }
      return { content: [{ type: 'text', text: `Error: ${result.error || JSON.stringify(result)}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed: ${err.message}` }] };
    }
  }
);

// Read channel history
mcp.tool(
  'darkhan_get_history',
  'Read recent messages from a Darkhan channel',
  {
    channel_id: z.string().describe('Channel ID'),
    limit: z.number().optional().describe('Number of messages (default 10)'),
  },
  async ({ channel_id, limit }) => {
    touchPromptTime();
    try {
      const n = limit || 10;
      const result = await darkhanRequest('GET', `/api/messages?channel_id=${channel_id}&limit=${n}`);
      const messages = result.messages || result;
      if (!Array.isArray(messages) || messages.length === 0) {
        return { content: [{ type: 'text', text: 'No messages.' }] };
      }
      const formatted = messages.map(m =>
        `[${m.created_at}] ${m.from_user}: ${m.body}`
      ).join('\n\n');
      return { content: [{ type: 'text', text: formatted }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed: ${err.message}` }] };
    }
  }
);

// --- Start ---

const transport = new StdioServerTransport();
mcp.connect(transport).then(() => {
  serverConnected = true;
});
