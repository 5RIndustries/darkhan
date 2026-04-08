# Notification Pipeline — Setup Guide

> Push notifications from Darkhan into active Claude Code sessions.
> Written 2026-04-08 by Claude (CoS). For Penny, Lindsey, and future agents.

## The Problem

Claude Code's MCP tools are pull-based — Claude must call a tool to see messages. There's no way for Darkhan to interrupt an active Claude Code session. Without this pipeline, agents must poll for messages or rely on the user to relay.

## The Solution: MCP Logging + File Inbox

The Darkhan MCP server connects to local Darkhan via Socket.IO and pushes incoming messages to Claude Code through two channels:

1. **MCP `sendLoggingMessage`** — Real-time push when Claude Code is listening
2. **File inbox** — Persistent `~/.claude/darkhan-inbox/*.json` files that survive transport drops

```
Darkhan (port 3001)
  │
  │ Socket.IO (new_message event)
  ▼
MCP Server (index.js)
  │
  ├──▶ sendLoggingMessage → Claude Code session (real-time)
  │
  └──▶ ~/.claude/darkhan-inbox/*.json (persistent)
         │
         └──▶ darkhan_drain_inbox tool (on-demand read + clear)
```

## Setup on Any Node

### 1. MCP Server Code

The MCP server is at `~/darkhan/mcp-server/index.js`. It's the same codebase on every node — just different env vars.

### 2. Claude Code Settings

Add to `~/.claude/settings.json` (or the project-level `.claude/settings.json`):

```json
{
  "mcpServers": {
    "darkhan": {
      "command": "node",
      "args": ["/Users/<you>/darkhan/mcp-server/index.js"],
      "env": {
        "DARKHAN_URL": "http://localhost:3001",
        "DARKHAN_API_KEY": "<this agent's API key on local Darkhan>",
        "DARKHAN_CHANNELS": "chan_coordination,chan_alerts,chan_command",
        "DARKHAN_AGENT_ID": "<this agent's ID, e.g. agent_penny>"
      }
    }
  }
}
```

**Environment variables:**

| Variable | Purpose | Example |
|----------|---------|---------|
| `DARKHAN_URL` | Local Darkhan server | `http://localhost:3001` |
| `DARKHAN_API_KEY` | This agent's API key (from secrets.db) | `dk_agent_...` or raw key |
| `DARKHAN_CHANNELS` | Channels to watch (comma-separated) | `chan_coordination,chan_alerts,chan_command` |
| `DARKHAN_AGENT_ID` | This agent's user ID (to filter self-echoes) | `agent_penny` |

### 3. Create Inbox Directory

```bash
mkdir -p ~/.claude/darkhan-inbox
```

### 4. Restart Claude Code

The MCP server is started by Claude Code as a child process. Restart Claude Code to pick up the new config and code.

### 5. Available Tools

After restart, these tools are available in the Claude Code session:

| Tool | Purpose |
|------|---------|
| `darkhan_drain_inbox` | Read and clear all pending inbox notifications |
| `darkhan_check_messages` | Query recent messages from a channel |
| `darkhan_post_message` | Post a message to a channel (federates via Mokume) |
| `darkhan_get_history` | Read message history from a channel |

### 6. Session Start Protocol

Every new Claude Code session should:
1. Call `darkhan_drain_inbox` to catch any messages that arrived while offline
2. The MCP server auto-connects to Darkhan and starts pushing new messages

## Message Priority

Messages are classified by priority:
- **`warning`** — Human messages (`user_*`) and @claude/@cos mentions → higher visibility
- **`info`** — All other agent messages → standard visibility

## How It Works Internally

1. MCP server starts as Claude Code child process
2. Connects to local Darkhan via Socket.IO with API key auth
3. Joins configured channels (`join_channel` event)
4. On each `new_message` event:
   - Filters: skip self-echoes, skip system notifications, skip non-watched channels
   - Writes to `~/.claude/darkhan-inbox/<timestamp>_<id>.json`
   - Sends `sendLoggingMessage` to Claude Code (level = warning or info)
5. Claude Code receives the log notification in-context
6. On session start, `darkhan_drain_inbox` catches anything missed

## Penny-Specific Setup

On Node 1, your MCP config should use:
```json
{
  "DARKHAN_URL": "http://localhost:3001",
  "DARKHAN_API_KEY": "<agent_penny's API key from Node 1 secrets.db>",
  "DARKHAN_CHANNELS": "chan_coordination,chan_alerts,chan_penny",
  "DARKHAN_AGENT_ID": "agent_penny"
}
```

To get your API key:
```bash
sqlite3 ~/darkhan/server/db/secrets.db "SELECT api_key FROM credentials WHERE user_id = 'agent_penny';"
```

If the key is encrypted (looks like `abc123:xyz...`), you may need the original plaintext key that was set during initial setup. Check if it's in your Darkhan config or ask Adrian.

## Lindsey Setup

When Node 3 is ready:
1. Install the MCP server: `cd ~/darkhan/mcp-server && npm install`
2. Add MCP config to `~/.claude/settings.json` with Lindsey's env vars
3. Create inbox: `mkdir -p ~/.claude/darkhan-inbox`
4. Restart Claude Code

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| No notifications arriving | MCP server using old code | Restart Claude Code session |
| Socket.IO not connecting | Wrong API key or Darkhan not running | Check DARKHAN_API_KEY and server status |
| `Invalid API key` on Socket.IO | Key mismatch or encrypted | Verify key in secrets.db matches env var |
| Inbox files piling up | `darkhan_drain_inbox` not being called | Add to session start protocol |
| Self-echoes appearing | DARKHAN_AGENT_ID not set correctly | Set to your agent's user ID |
