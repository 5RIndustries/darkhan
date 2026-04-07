#!/usr/bin/env node
/**
 * Darkhan MCP Server
 *
 * Always-on bridge between Darkhan workspace and Claude Code CLI.
 * Connects to local Darkhan via Socket.IO, surfaces federated messages
 * as MCP tools. Same pattern as the Telegram MCP plugin.
 *
 * Registered in ~/.claude/settings.json under mcpServers.
 * Claude Code auto-starts this as a child process.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { io } from 'socket.io-client';
import http from 'http';

const DARKHAN_URL = process.env.DARKHAN_URL || 'http://localhost:3001';
const API_KEY = process.env.DARKHAN_API_KEY || '';
const CHANNELS = (process.env.DARKHAN_CHANNELS || 'chan_coordination,chan_alerts').split(',');

// Message queue — federated messages waiting for the CLI to read
const messageQueue = [];
const MAX_QUEUE = 50;

// Connect to Darkhan via Socket.IO
const socket = io(DARKHAN_URL, {
  reconnection: true,
  reconnectionDelay: 3000,
  reconnectionAttempts: Infinity,
  timeout: 10000,
});

socket.on('connect', () => {
  // Join federated channels
  for (const ch of CHANNELS) {
    socket.emit('join', ch);
  }
});

socket.on('new_message', (msg) => {
  // Only queue federated messages (from other nodes) and non-auto-responder
  if (!msg.from_user || !msg.from_user.includes('@')) return;
  if (msg.type === 'notification') return; // Skip notification echoes
  if (!CHANNELS.includes(msg.channel_id)) return;

  messageQueue.push({
    from: msg.from_user,
    channel: msg.channel_id,
    body: msg.body,
    timestamp: msg.created_at || new Date().toISOString(),
  });

  // Cap queue
  while (messageQueue.length > MAX_QUEUE) messageQueue.shift();
});

// HTTP helper for Darkhan API
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

// Create MCP server
const server = new McpServer({
  name: 'darkhan',
  version: '0.1.0',
});

// Tool: check for pending federated messages
server.tool(
  'darkhan_check_messages',
  'Check for pending federated messages from other agents via Mokume',
  {},
  async () => {
    if (messageQueue.length === 0) {
      return { content: [{ type: 'text', text: 'No pending messages.' }] };
    }
    const messages = messageQueue.splice(0, messageQueue.length);
    const formatted = messages.map(m =>
      `[${m.timestamp}] ${m.from} in ${m.channel}: ${m.body}`
    ).join('\n\n');
    return { content: [{ type: 'text', text: formatted }] };
  }
);

// Tool: post a message to a Darkhan channel
server.tool(
  'darkhan_post_message',
  'Post a message to a Darkhan channel (federates via Mokume to other nodes)',
  {
    channel_id: z.string().describe('Channel ID (e.g. chan_coordination, chan_alerts)'),
    body: z.string().describe('Message body'),
  },
  async ({ channel_id, body }) => {
    try {
      const result = await darkhanRequest('POST', '/api/messages', { channel_id, body });
      if (result.ok) {
        return { content: [{ type: 'text', text: `Posted to ${channel_id}` }] };
      }
      return { content: [{ type: 'text', text: `Error: ${result.error || JSON.stringify(result)}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed: ${err.message}` }] };
    }
  }
);

// Tool: read recent messages from a channel
server.tool(
  'darkhan_get_history',
  'Read recent messages from a Darkhan channel',
  {
    channel_id: z.string().describe('Channel ID'),
    limit: z.number().optional().describe('Number of messages (default 10)'),
  },
  async ({ channel_id, limit }) => {
    try {
      const n = limit || 10;
      const result = await darkhanRequest('GET', `/api/messages?channel_id=${channel_id}&limit=${n}`);
      if (Array.isArray(result)) {
        const formatted = result.map(m =>
          `[${m.created_at}] ${m.from_user}: ${m.body}`
        ).join('\n\n');
        return { content: [{ type: 'text', text: formatted || 'No messages.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed: ${err.message}` }] };
    }
  }
);

// Start MCP server on stdio
const transport = new StdioServerTransport();
await server.connect(transport);
