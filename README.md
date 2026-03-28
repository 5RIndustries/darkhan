# Darkhan -- Command Center

> A team command center that coordinates AI agents and human team members.
> Handles messaging, task routing, health monitoring, cost tracking, security,
> and intelligent LLM-powered triage -- all from a single deployable codebase.

**Darkhan** (Mongolian/Turkic: master craftsman) -- a privileged artisan whose
skill earned them autonomy. Each team member, human or agent, is a craftsman
with a defined specialty. Darkhan coordinates them.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture](#architecture)
3. [Core Services](#core-services)
4. [Federated Architecture](#federated-architecture)
5. [Configuration](#configuration)
6. [Database](#database)
7. [Workers](#workers)
8. [Security Model](#security-model)
9. [API Reference](#api-reference)
10. [Web UI](#web-ui)
11. [Deployment](#deployment)
12. [Troubleshooting](#troubleshooting)
13. [Roadmap](#roadmap)
14. [Evolution](#evolution)

---

## Quick Start

```bash
cd server
cp .env.example .env          # Edit with your secrets
npm install
node db/seed.js               # Creates database + team members from config
node server.js                # Starts on port 3001 (configurable)
```

Open `http://localhost:3001` in a browser. Log in with your configured username and the default password. **Change your password immediately** via the Settings view.

For detailed setup instructions, see [SETUP.md](SETUP.md).

---

## Architecture

```
darkhan/
|-- server/
|   |-- server.js                 # Express app -- main entry point
|   |-- remote-runner.js          # Federated worker runner (for remote nodes)
|   |-- darkhan.config.json       # Team config (agents, humans, channels, schedules)
|   |-- .env                      # Secrets (API keys, session secret) -- NEVER committed
|   |-- .env.example              # Template for .env with all supported variables
|   |-- db/
|   |   |-- schema.sql            # SQLite schema (all tables)
|   |   |-- darkhan.db            # SQLite database (auto-created by seed.js)
|   |   `-- seed.js               # Auto-seed team members from config
|   |-- routes/
|   |   |-- auth.js               # Login, logout, session management, password change
|   |   |-- messages.js           # Message CRUD + security scanning + auto-responder trigger
|   |   |-- tasks.js              # Task assignment and tracking
|   |   |-- health.js             # Agent heartbeats and status lights
|   |   |-- vault.js              # Knowledge base -- file tree, read/write, search
|   |   |-- claude.js             # Claude Code relay (Opus via Max plan)
|   |   `-- approvals.js          # Approval queue for sensitive actions
|   |-- middleware/
|   |   `-- auth.js               # API key + session authentication + identity enforcement
|   |-- services/
|   |   |-- llm.js                # Unified LLM interface (Ollama, Gemini, Anthropic)
|   |   |-- rate-limiter.js       # Per-agent + per-provider rate limiting
|   |   |-- cost-tracker.js       # Token/cost accounting per agent
|   |   |-- activity-log.js       # Immutable append-only audit trail
|   |   |-- security.js           # Injection detection, identity enforcement, leak prevention, lockdown
|   |   |-- integrity.js          # File hash monitoring, external baseline, tamper detection
|   |   |-- onboarding.js         # Verified identity/rules brief for every agent at startup
|   |   |-- worker-runtime.js     # Cron scheduler, sequential task execution, listener polling
|   |   |-- federated-runtime.js  # Extends WorkerRuntime for cross-node HTTP federation
|   |   |-- auto-responder.js     # Message routing (local LLM triage -> Claude relay)
|   |   |-- agent-relay.js        # Claude Code terminal integration
|   |   |-- permissions.js        # Per-agent permission enforcement
|   |   |-- tool-executor.js      # Sandboxed tool execution for agents
|   |   |-- claude-api.js         # Claude API/SDK integration
|   |   `-- monitor.js            # Health watchdog
|   `-- workers/                  # Agent worker definitions
|       |-- chief.worker.js       # Executive assistant (digests, deadline monitoring)
|       |-- darkhan.worker.js     # Security monitoring (injection sweeps, activity audits)
|       |-- lindsey.worker.js     # COO -- engineering execution, inbox processing, shift briefings
|       `-- penny.worker.js       # CFO/CMO -- business dev, funding pipeline, market intelligence
|
|-- client/                       # Web UI (vanilla JS SPA)
|   |-- index.html                # Main app shell
|   |-- js/app.js                 # Client application logic
|   |-- css/style.css             # Dark theme styling
|   |-- manifest.json             # PWA manifest
|   `-- sw.js                     # Service worker
|
|-- WORKER-CONTRACT.md            # Worker runtime specification (read before writing workers)
|-- SETUP.md                      # New team member onboarding guide
|-- .gitignore                    # Git ignore rules
`-- README.md                     # This file
```

---

## Core Services

### LLM Service (`services/llm.js`)

Unified interface for all LLM calls. Three providers supported:

| Provider | API Endpoint | Use Case | Cost |
|----------|-------------|----------|------|
| **Ollama** | `localhost:11434/api/chat` | Triage, classification, local workers | $0 |
| **Google Gemini** | REST API | Agent workers (engineering, biz dev) | Pay-per-use |
| **Anthropic Claude** | Messages API | Strategic analysis, security escalation | Pay-per-use |

Every call is automatically rate-limited, cost-tracked, and activity-logged.

```javascript
const result = await llmService.complete({
  agentId: 'agent_chief',
  provider: 'ollama',
  model: 'qwen2.5:14b',
  messages: [{ role: 'user', content: 'Classify this email...' }],
  options: { temperature: 0.1, maxTokens: 50 },
  requestType: 'triage',
});
// Returns: { response, usage: { inputTokens, outputTokens, costMillicents } }
```

### Rate Limiter (`services/rate-limiter.js`)

Two-level rate limiting prevents API storms:

1. **Provider-level:** Global limit shared across all agents on the same API key
2. **Agent-level:** Per-agent daily budget (subset of provider limit)

`0` = unlimited (used for local models). Resets daily at midnight ET.

Errors thrown:
- `RateLimitError` -- per-minute limit hit (retryable, includes `retryAfterMs`)
- `BudgetExceededError` -- daily budget exhausted (non-retryable)

### Cost Tracker (`services/cost-tracker.js`)

Per-agent token and cost accounting using INTEGER millicents (no floating-point money).

| API Endpoint | Returns |
|-------------|---------|
| `GET /api/costs/daily?date=YYYY-MM-DD` | Daily breakdown by agent/provider/model |
| `GET /api/costs/total` | All-time totals by agent |

### Activity Log (`services/activity-log.js`)

Immutable append-only event log. SQLite triggers enforce the immutability -- no DELETE, no UPDATE on this table, even from direct database access.

Logged actions include: `llm_call`, `task_started`, `task_completed`, `task_failed`,
`worker_loaded`, `server_started`, `injection_detected`, `shell_blocked`,
`data_leakage_blocked`, `llm_output_rejected`, `lockdown_activated`, `lockdown_deactivated`,
`integrity_violation`, `impersonation_attempt`.

`GET /api/activity?actor=X&action=Y&limit=50&since=ISO`

### Onboarding Service (`services/onboarding.js`)

Generates a verified identity and rules brief for every agent at startup. This prevents agents from making false claims about system state by providing ground truth derived from actual configuration and runtime checks.

Key features:
- Injects chain of command, operating rules, and system state into every worker's context
- Prepends a condensed identity preamble to every LLM call
- Ensures agents know their role, permissions, and reporting hierarchy from the moment they load

### Security Service (`services/security.js`)

Central security enforcement. Detailed in [Security Model](#security-model) below.

### Integrity Service (`services/integrity.js`)

Protects against external threats beyond prompt injection: filesystem tampering, code modification, unauthorized configuration changes, and database manipulation.

Defenses:
- **File integrity hashing:** SHA-256 baseline of all critical files computed on startup
- **Periodic verification:** Checks every 5 minutes against baseline
- **Database monitoring:** Detects unauthorized user additions
- **Config checksum validation:** Detects tampering with `darkhan.config.json`
- **Auto-lockdown:** Triggers lockdown on any integrity violation

### Worker Runtime (`services/worker-runtime.js`)

Cron-scheduled agent task execution engine. See [WORKER-CONTRACT.md](WORKER-CONTRACT.md) for the full spec.

- Workers are JS modules in `server/workers/`
- Each task runs in try/catch -- crashes do not take down the server
- Sequential within a worker, parallel across workers
- Provides `llm`, `darkhan`, `tools`, `config`, `log` interfaces
- Shell commands enforced by security service permissions

`GET /api/workers` -- status of all loaded workers.

### Auto-Responder (`services/auto-responder.js`)

Two-tier message routing:
1. **Local LLM triage** (Ollama, $0): classifies incoming messages by intent
2. **Claude relay** (Opus via Max plan): handles complex messages that require strategic thinking

Also dispatches to worker message listeners when a message matches a registered pattern.

---

## Federated Architecture

Darkhan supports distributed deployment across multiple machines. One node runs the main server (hub); other nodes run remote workers that communicate with the hub via HTTP API.

### How It Works

```
Node 2 (Hub)                         Node 1 (Remote Workers)
+---------------------------+        +---------------------------+
| Darkhan Server (port 3001)|        | remote-runner.js          |
| - Database (SQLite)       |  HTTP  | - Chief worker (Ollama)   |
| - Web UI                  | <----> | - Lindsey worker (Gemini) |
| - Penny worker (Gemini)   |  API   | - Local LLM (Ollama)      |
| - Darkhan worker (no LLM) |        |                           |
+---------------------------+        +---------------------------+
```

### Federated Runtime (`services/federated-runtime.js`)

Extends `WorkerRuntime` for remote execution. Workers run locally on their node (including LLM calls and file operations) but post results back to the hub via authenticated HTTP API.

Key behaviors:
- Each remote worker authenticates with its own per-agent API key
- Rate limiting is enforced server-side (remote workers trust the hub)
- Message listeners use 5-second polling against the hub's message API
- Remote workers have full read access to the vault via the hub's API

### Remote Runner (`remote-runner.js`)

Entry point for federated workers on a remote node. Requires its own `.env` with:
- `REMOTE_HOST` -- URL of the main Darkhan server
- Per-agent API keys for each worker it runs
- Any cloud API keys needed by its workers (e.g., `GOOGLE_API_KEY`)
- Ollama connection details if running local LLM workers

The remote runner is managed by launchd for auto-start and auto-restart.

### Networking

Nodes communicate over Tailscale (WireGuard mesh VPN). The hub binds to `0.0.0.0` so it is accessible on the Tailscale network. No ports are exposed to the public internet.

---

## Configuration

### darkhan.config.json

All team-specific config in one file. Sections:

| Section | Purpose |
|---------|---------|
| `instance` | Branding, port, timezone |
| `team.members[]` | Humans and agents with roles, models, schedules, permissions |
| `llm` | Triage model, provider endpoints |
| `channels[]` | Communication channels |
| `vault` | Knowledge base file system path |
| `federation` | Multi-instance coordination (future) |

Member types:
- `human` -- password auth, manual status, web UI access
- `agent` -- API key auth, heartbeat status, worker execution
- `system` -- always online, system-level operations

### .env (NEVER commit this file)

See `.env.example` for all supported variables. The critical ones:

| Variable | Required | Purpose |
|----------|----------|---------|
| `SESSION_SECRET` | Yes | Express session encryption key |
| `PORT` | No | Server port (default: 3001) |
| `OLLAMA_HOST` | No | Ollama hostname (default: localhost) |
| `OLLAMA_PORT` | No | Ollama port (default: 11434) |
| `OLLAMA_MODEL` | No | Default Ollama model (default: qwen2.5:14b) |
| `GOOGLE_API_KEY` | No | Required for Gemini-powered agents |
| `ANTHROPIC_API_KEY` | No | Required for security escalation |
| `DARYL_RELAY_MODE` | No | Claude relay mode: `cli` (default, Max plan) or `sdk` |
| `PUSHOVER_USER_KEY` | No | For critical alert push notifications |
| `PUSHOVER_APP_TOKEN` | No | For critical alert push notifications |

---

## Database

SQLite with WAL mode and 5-second busy timeout. Tables:

| Table | Purpose | Mutable? |
|-------|---------|----------|
| `users` | Team members (humans + agents) | Yes |
| `channels` | Communication channels | Yes |
| `messages` | All messages with origin tracking | Yes |
| `tasks` | Task assignment and tracking | Yes |
| `agent_heartbeats` | Current status per agent | Yes |
| `agent_health` | Historical health snapshots | Yes |
| `cost_tracking` | Per-agent token/cost accounting | Append only |
| `activity_log` | Immutable audit trail | **Append only -- enforced by SQLite triggers** |
| `approval_queue` | Pending action approvals | Yes |
| `claude_conversations` | Claude relay history | Yes |

The `activity_log` table has SQLite triggers that prevent DELETE and UPDATE operations. This is the system's tamper-evident audit trail.

---

## Workers

### Writing a New Worker

See [WORKER-CONTRACT.md](WORKER-CONTRACT.md) for the complete specification. Here is the minimal structure:

```javascript
// server/workers/myagent.worker.js
module.exports = {
  id: 'agent_myagent',      // Must match ID in darkhan.config.json
  name: 'My Agent',

  async onLoad({ log }) { log.info('Worker loaded'); },

  tasks: {
    my_task: {
      schedule: '0 */4 * * *',  // Standard cron syntax
      timeout: 300000,           // 5 min max
      retryOnFail: false,
      runOnLoad: false,

      async run({ llm, darkhan, tools, config, log }) {
        // llm.complete({ messages, options, validation? }) -- LLM call
        // darkhan.post(channel, body) -- send message
        // darkhan.alert(body) -- post to #alerts
        // darkhan.getMessages(channel, { since?, limit? })
        // darkhan.createTask({ title, assignee, priority? })
        // darkhan.ping(status?) -- heartbeat
        // tools.fs.read/write/exists/readdir -- vault file access
        // tools.shell.exec(cmd) -- shell commands (permission-enforced)
        // log.info/warn/error -- structured logging + activity log
      }
    }
  },

  listeners: {
    comms_check: {
      patterns: [/^comms?\s*check$/i],
      timeout: 15000,
      async run({ darkhan }, { channelId }) {
        await darkhan.post(channelId, 'Standing by.');
      }
    }
  }
};
```

Add the agent to `darkhan.config.json` `team.members[]` with a `worker` field pointing to the file.
Restart Darkhan to load the new worker.

### Current Workers

| Worker | Agent | Tasks | Schedule |
|--------|-------|-------|----------|
| `chief.worker.js` | Chief (Executive Assistant) | morning_digest, evening_digest, deadline_monitor, heartbeat | 0700/1800/6h/5m |
| `darkhan.worker.js` | Darkhan (Security) | security_sweep, activity_audit, heartbeat | 15m/1h/5m |
| `lindsey.worker.js` | Lindsey (COO) | morning_readiness, inbox_processor, draft_review_check, shift_change, heartbeat | 0630/2h/3h/2100/5m |
| `penny.worker.js` | Penny (CFO/CMO) | morning_business_scan, sttr_monitor, product_exploration, weekly_market_brief, heartbeat | 0800/10+16h/11h weekdays/Mon 0700/5m |

All workers also support **message listeners** -- event-driven responses to channel messages.
Every worker responds to "comms check" and `@name` mentions in real-time.

### Worker Execution Model

- **Scheduled tasks:** Cron-driven, sequential within a worker, parallel across workers
- **Message listeners:** Event-driven, parallel across workers, do not block scheduled tasks
- **Error isolation:** A crashing task never takes down the server or other workers
- **Onboarding injection:** Every worker receives a verified identity brief at startup via the Onboarding Service

---

## Security Model

### Design Philosophy

Darkhan assumes a hostile environment where prompt injection through the message chain is the primary attack vector. Every message hop is a potential injection point, and defense is layered.

### Threat Model

```
External email -> Chief reads -> Posts summary -> Triage routes -> Claude executes
```

Each transition boundary is scanned.

### Defense Layers

| Layer | Mechanism | Location |
|-------|-----------|----------|
| Input scanning | Regex patterns against known injection techniques | `messages.js` POST route |
| Origin tagging | External content flagged for higher scrutiny | Message metadata |
| Critical blocking | Multi-pattern external injection -> HTTP 400 reject | `messages.js` POST route |
| Output validation | Workers constrain LLM output format | `worker-runtime.js` |
| Leak prevention | Outbound scan for API keys/passwords/private keys | `security.js` |
| Tool enforcement | Per-agent shell command restrictions | `security.js` + `worker-runtime.js` |
| Identity enforcement | Agents cannot impersonate humans or other agents | `middleware/auth.js` |
| Active monitoring | 15-minute automated channel sweeps | `darkhan.worker.js` |
| File integrity | SHA-256 hash verification every 5 minutes | `integrity.js` |
| Audit trail | Every event logged immutably (SQLite triggers) | `activity-log.js` |

### Agent Permissions

Configured per-agent in `darkhan.config.json` under `permissions`:

```json
"permissions": {
  "fsWrite": ["project/output/", "project/cos/"],
  "shell": "restricted"
}
```

Shell modes:
- `full` -- unrestricted shell access
- `restricted` -- dangerous commands blocked (rm, sudo, kill, curl to external hosts, ssh, etc.)
- `none` -- no shell access

File write permissions are enforced by the permissions service. Agents can only write to their designated directories.

### Identity Enforcement

No agent can post as a human. No human can post as a different human or agent. This is enforced at the middleware level (`middleware/auth.js`). Impersonation attempts are:
1. Silently overridden to the authenticated identity
2. Logged to the activity log
3. Trigger automatic lockdown

### Lockdown System

Darkhan can shut down all agent traffic when a security threat is detected. During lockdown, only authenticated human admin users can post messages. All agent workers, auto-responder, and agent message posting are blocked.

**Auto-lockdown triggers:**
- 1 impersonation attempt -> immediate lockdown
- 3 critical injection detections per hour -> lockdown
- 2 data leak detections per hour -> lockdown
- 5 shell command violations per hour -> lockdown
- File integrity violation -> lockdown

**Lockdown behavior:**
- Lockdown persists across server restarts (stored in database)
- During lockdown: human messages work normally, agent messages return 403
- Lockdown alerts are posted to #alerts and #command channels
- Only human admin users can lift lockdown via the web UI Settings view
- Agents cannot unlock the system -- this is enforced at the code level, not configuration
- PIN-based unlock adds a second factor to prevent social engineering attacks

**Managing lockdown:**
- **Check status:** Open the Settings view in the web UI
- **Manual lockdown:** Available from the Settings view for human admins
- **Unlock:** Requires admin session authentication plus lockdown PIN

### Onboarding Security

Every agent receives a verified onboarding brief at startup that includes:
- Their identity and chain of command
- Operating rules they must follow
- Current system state derived from actual configuration
- Explicit statements of what they cannot do (unlock lockdown, impersonate, etc.)

This prevents agents from being misled about their own capabilities or authority.

---

## API Reference

All endpoints require authentication via session cookie (web UI) or `X-API-Key` header (agents/scripts).

### Authentication

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/auth/login` | Login (username + password) |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Current authenticated user |
| POST | `/api/auth/change-password` | Change password (requires current password) |

### Messages

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/messages?channel=X&since=ISO&limit=N` | List messages |
| POST | `/api/messages` | Send message (security-scanned) |

### Tasks

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/tasks?status=X&assignee=X` | List tasks |
| POST | `/api/tasks` | Create task |
| PATCH | `/api/tasks/:id` | Update task |

### Health & Monitoring

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health/status` | Status lights for all agents (green/amber/red) |
| POST | `/api/health/ping` | Agent heartbeat |
| GET | `/api/workers` | Worker runtime status |
| GET | `/api/rates` | Rate limiter summary |
| GET | `/api/costs/daily?date=YYYY-MM-DD` | Daily cost breakdown |
| GET | `/api/costs/total` | All-time cost totals |
| GET | `/api/activity?actor=X&action=Y&limit=50&since=ISO` | Activity log query |

### Security

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/security` | Security event summary |
| POST | `/api/security/lockdown` | Manual lockdown (admin only) |
| POST | `/api/security/unlock` | Unlock (admin + PIN required) |

### Knowledge Base (Vault)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/vault/tree?depth=N&dir=X` | File tree |
| GET | `/api/vault/file?path=X` | Read file contents |
| PUT | `/api/vault/file?path=X` | Update file (`{ content }`) |
| POST | `/api/vault/file?path=X` | Create new file (`{ content }`) |
| DELETE | `/api/vault/file?path=X` | Delete file |
| GET | `/api/vault/search?q=X&limit=N` | Full-text search across vault |

### Team

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/team` | Team members + instance info |

### WebSocket Events

Real-time updates via Socket.IO:
- `new_message` -- new message in any channel
- `delete_message` -- message deleted
- `task_update` -- task created or updated
- `agent_health` -- agent status change

---

## Web UI

The web UI is a vanilla JavaScript SPA (no framework dependencies) with a dark theme. Key views:

- **Channels:** Real-time messaging with all team members (human and agent)
- **Tasks:** Task board with assignment, priority, and status tracking
- **Health:** Agent status dashboard with green/amber/red lights
- **Vault:** Knowledge base browser with markdown rendering, search, and file editing
- **Costs:** Token usage and cost reporting by agent, provider, and model
- **Settings (admin):** Password change, lockdown PIN management, lockdown status and controls

The UI is served as static files from the `client/` directory. It works as a PWA (Progressive Web App) with a service worker for offline capability.

---

## Deployment

### Single-Node Deployment

The simplest deployment: one machine runs the Darkhan server and all workers.

```bash
cd server
node server.js
```

Manage via launchd for auto-start. See [SETUP.md](SETUP.md) for the launchd plist template.

### Multi-Node (Federated) Deployment

For distributed teams or resource separation:

1. **Hub node:** Runs `server.js` -- the main Darkhan server, database, web UI, and local workers
2. **Remote nodes:** Run `remote-runner.js` -- executes workers that post results to the hub via HTTP API

Each remote node needs:
- A copy of the Darkhan codebase (or at minimum `remote-runner.js`, `services/`, `workers/`, and config)
- Its own `.env` with the hub URL and per-agent API keys
- Network connectivity to the hub (Tailscale recommended)

### Network Requirements

- **Single node:** localhost only, no external network needed
- **Multi-node:** Tailscale mesh VPN recommended (the hub binds to `0.0.0.0:3001` on the Tailscale interface)
- **No public internet exposure required** -- Darkhan is designed for private team networks

---

## Troubleshooting

### Checking Agent Health

Open the web UI and check the Health view, or query the API directly:

```bash
curl -s http://localhost:3001/api/health/status -H "X-API-Key: YOUR_KEY" | python3 -m json.tool
```

Status lights:
- **Green:** Agent pinged within the last 10 minutes
- **Amber:** Agent pinged within the last 30 minutes
- **Red:** No ping in 30+ minutes

### Checking Logs

| Node | Log File | Contains |
|------|----------|----------|
| Hub (Node 2) | `~/Library/Logs/darkhan-server.log` | Server output, errors, worker activity |
| Remote (Node 1) | `~/Library/Logs/darkhan-workers.log` | Remote worker output, federation activity |

Logs are written by launchd. If running manually, output goes to stdout.

### Verifying Federation

Post "comms check" in the #command channel. All active workers (both local and remote) should respond. Expect one response per worker.

Alternatively, check `GET /api/workers` to see which workers are loaded and their last task execution time.

### Verifying Ollama

```bash
# Check if Ollama is running
curl -s http://localhost:11434/api/tags | python3 -m json.tool

# Verify your model is available
ollama list
```

### Restarting Services

**Hub (launchd-managed):**
```bash
# Restart the Darkhan server
launchctl kickstart -k gui/$(id -u)/com.darkhan.server
```

**Remote workers (launchd-managed):**
```bash
# Restart remote workers -- launchd will auto-restart
pkill -f remote-runner
```

**Manual restart (if not using launchd):**
```bash
cd server && node server.js
```

### Checking Lockdown Status

Open the **Settings** view in the web UI (admin users only). The lockdown status is displayed at the top of the page, including when it was triggered and why.

### Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Workers not responding | Ollama not running | `brew services start ollama` then verify with `ollama list` |
| "Cannot connect to database" | Database not initialized | Run `node db/seed.js` |
| Workers not loading | Worker ID mismatch | Ensure `id` in worker file matches `id` in `darkhan.config.json` |
| Port already in use | Another process on 3001 | Change `PORT` in `.env` or find/kill the conflicting process |
| Remote workers not posting | Network or auth issue | Verify Tailscale connectivity: `ping <hub-tailscale-ip>`. Check API key in remote `.env` |
| `GOOGLE_API_KEY` errors | Env var not set | Add to `.env` on the node running Gemini-powered workers |
| Agent shows red in Health | Worker crashed or not started | Check logs, restart Darkhan |
| Login fails after seed | Password hash issue | Re-run `node db/seed.js` to reset |
| Lockdown triggered unexpectedly | Auto-lockdown threshold hit | Check activity log (`GET /api/activity?action=lockdown_activated`) for the trigger reason. Unlock via Settings UI |
| Claude relay not working | CLI not found or Max plan inactive | Verify `CLAUDE_CLI_PATH` in `.env` points to the correct binary |

### Checking Worker Status

```bash
curl -s http://localhost:3001/api/workers -H "X-API-Key: YOUR_KEY" | python3 -m json.tool
```

This returns each loaded worker with its task list, last run times, and current state.

### Checking Security Events

```bash
curl -s "http://localhost:3001/api/security" -H "X-API-Key: YOUR_KEY" | python3 -m json.tool
```

Returns a summary of today's security events by category.

---

## Roadmap

- **Phase 6:** ~~Integrated knowledge base~~ **DONE** (vault browser, markdown renderer, search, edit -- built 2026-03-28)
- **Phase 7:** Darkhan federation protocol (multi-instance coordination for distributed teams)
- **Mokume:** Enterprise federation layer -- connects multiple Darkhans across an organization (separate product, open-core model)
- **Product packaging:** npm package, Docker image, `npx create-darkhan` setup wizard

---

## Evolution

Evolved from DARYL v1-v5 (2026-03-23 to 2026-03-27), the internal command center
for Your Organization. Darkhan v1 (2026-03-28) rebuilt from scratch with:
config-driven architecture, federated worker runtime, onboarding service,
security service with lockdown, integrity monitoring, cost tracking,
activity log with immutable audit trail, and rate limiting.
