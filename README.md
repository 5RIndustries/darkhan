# Darkhan -- The Forge

> A team command center where AI agents and humans work as a single unit.
> Messaging, task routing, health monitoring, cost tracking, security,
> and intelligent LLM-powered triage -- all from a single deployable codebase.

**Darkhan** (Mongolian/Turkic: master craftsman) -- a privileged artisan whose
skill earned them autonomy. The forge is where craftsmen work. Each team member,
human or agent, is a craftsman with a defined specialty. Darkhan is the forge
that coordinates them -- shaping raw capability into reliable output.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture](#architecture)
3. [Core Services](#core-services)
4. [Evidence and Claim Verification](#evidence-and-claim-verification)
5. [Federated Architecture](#federated-architecture)
6. [Configuration](#configuration)
7. [Database](#database)
8. [Workers](#workers)
9. [Security Model](#security-model)
10. [Break-Glass Recovery](#break-glass-recovery)
11. [API Reference](#api-reference)
12. [Web UI](#web-ui)
13. [Deployment](#deployment)
14. [Troubleshooting](#troubleshooting)
15. [Roadmap](#roadmap)
16. [Evolution](#evolution)

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
|   |   |-- schema.sql            # SQLite schema (operational tables)
|   |   |-- secrets-schema.sql    # Secrets DB schema (credentials, PINs -- isolated)
|   |   |-- darkhan.db            # SQLite database (auto-created by seed.js)
|   |   |-- secrets.db            # Credentials database (auto-created, 600 permissions)
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
|   |   |-- evidence.js           # Evidence-based reporting with SHA-256 hashing
|   |   |-- claim-verifier.js     # Automatic claim tagging on agent messages
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
|       |-- chief.worker.js       # Executive assistant (digests, deadline monitoring, daily briefing)
|       |-- darkhan.worker.js     # Security monitoring (injection sweeps, activity audits)
|       |-- lindsey.worker.js     # COO -- engineering execution, inbox processing, shift briefings
|       `-- penny.worker.js       # CFO/CMO -- business dev, funding pipeline, market intelligence
|   |-- break-glass.js           # Emergency admin recovery tool (interactive TTY only)
|   |-- services/                # (additional services beyond those listed above)
|   |   |-- ground-truth.js      # Ground Truth Registry -- canonical verified facts
|   |   |-- sandbox.js           # Native macOS sandbox -- process isolation for agents
|   |   `-- keychain.js          # macOS Keychain integration for secret storage
|   `-- scripts/
|       |-- generate-certs.sh        # mTLS certificate generator (CA + per-node certs with SAN)
|       |-- setup-service-user.sh    # Creates _darkhan service user for privilege separation
|       |-- setup-keychain.sh        # Provisions macOS Keychain items for Darkhan secrets
|       `-- com.darkhan.server.plist # launchd template for running as _darkhan
|
|-- client/                       # Web UI (vanilla JS SPA)
|   |-- index.html                # Main app shell
|   |-- js/app.js                 # Client application logic
|   |-- css/style.css             # Dark theme styling
|   |-- manifest.json             # PWA manifest
|   `-- sw.js                     # Service worker
|
|-- .github/                      # GitHub templates (issues, PRs)
|-- WORKER-CONTRACT.md            # Worker runtime specification (read before writing workers)
|-- SETUP.md                      # New team member onboarding guide
|-- SECURITY.md                   # Security policy and vulnerability reporting
|-- CONTRIBUTING.md               # Contribution guidelines
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

Immutable append-only event log with hash chain integrity. SQLite triggers enforce the immutability -- no DELETE, no UPDATE on this table, even from direct database access.

Each entry includes:
- **origin** -- instance ID that created the entry (supports federated auditing)
- **entry_type** -- `event` (normal), `spacer` (CRISPR defense), or `anchor` (periodic checkpoint)
- **SHA-256 hash chain** -- each entry's hash includes the previous entry's hash, forming a Merkle chain

**CRISPR defense spacers:** On security events (injection detection, lockdown activation, exfiltration attempts), the system automatically inserts a defense spacer into the hash chain. Spacers mark the exact point where a security event occurred, making post-hoc log tampering detectable even if the attacker controls the database.

**Chain anchors:** Periodic checkpoint entries that allow independent verification of chain integrity without replaying the entire history.

Logged actions include: `llm_call`, `task_started`, `task_completed`, `task_failed`,
`worker_loaded`, `server_started`, `injection_detected`, `shell_blocked`,
`data_leakage_blocked`, `llm_output_rejected`, `lockdown_activated`, `lockdown_deactivated`,
`integrity_violation`, `impersonation_attempt`.

| API Endpoint | Purpose |
|-------------|---------|
| `GET /api/activity?actor=X&action=Y&limit=50&since=ISO` | Query activity log |
| `GET /api/activity/chain-head` | Current chain head hash and entry count |
| `GET /api/activity/stats` | Chain statistics (total entries, spacers, anchors, by origin) |
| `GET /api/activity/spacers` | List all CRISPR defense spacers |
| `POST /api/activity/spacers/ingest` | Ingest spacers from a federated instance |

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

### Ground Truth Registry (`services/ground-truth.js`)

Canonical store of verified facts about the organization, infrastructure, and team. Prevents agents from contradicting known ground truth in their output.

- **15 verified facts** seeded on initialization with **43 aliases** for flexible lookup
- Each fact has a key, value, category, aliases, source attribution, and optional expiry
- Integrated into the Claim Verifier pipeline: agent messages are checked for contradictions against the registry before storage
- Admin API for adding, querying, deprecating, and bulk-checking facts

| API Endpoint | Purpose |
|-------------|---------|
| `GET /api/ground-truth` | List all active ground truth entries |
| `POST /api/ground-truth` | Add a new verified fact (admin only) |
| `POST /api/ground-truth/:key/deprecate` | Deprecate an entry (admin only) |
| `GET /api/ground-truth/brief/text` | Plain-text brief of all facts (for agent consumption) |
| `POST /api/ground-truth/check` | Check a claim against the registry for contradictions |

### Sandbox Service (`services/sandbox.js`)

Native macOS process isolation for agent-executed commands. Enforces security boundaries without Docker or VMs.

- **Environment whitelist:** Only 5 variables passed to sandboxed processes (`HOME`, `PATH`, `LANG`, `USER`, `TERM`)
- **Filesystem deny-list:** Blocks access to `db/`, `.env`, `.ssh`, `.gnupg`, TLS certificates, and other sensitive paths
- **Resource watchdog:** Monitors memory usage per process, kills processes exceeding configured limits
- **SBPL profile generation:** Produces `sandbox-exec` profiles for macOS kernel-level enforcement
- Configured via the `sandbox` section in `darkhan.config.json`

### Keychain Service (`services/keychain.js`)

macOS Keychain integration for storing critical secrets outside the filesystem.

- Stores secrets in the system keychain rather than `.env` or database files
- Setup via `scripts/setup-keychain.sh`
- Falls back to `.env` if keychain is not configured (for development or non-macOS systems)
- Part of the Layer 3 security hardening stack

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

## Evidence and Claim Verification

Darkhan separates verified facts from LLM-generated analysis in every report. Two services work together to ensure agents cannot fabricate claims.

### Evidence Service (`services/evidence.js`)

Structured evidence-based reporting. Every factual claim in a Darkhan report is backed by a code-level check with a tamper-detection hash.

**How `evidence.check()` works:**

```javascript
const result = await evidence.check({
  claim: 'File .env has 600 permissions',   // What is being asserted
  method: 'fs.stat',                         // How it is checked
  target: '/path/to/.env',                   // What is being checked
  check: async () => {                       // The actual check function
    const stat = await fs.promises.stat(target);
    const mode = (stat.mode & 0o777).toString(8);
    return { pass: mode === '600', actual: mode };
  },
});
// Returns: { claim, method, target, result: { pass, actual }, timestamp, hash }
```

Each evidence record includes a SHA-256 hash computed from `claim + method + JSON(result) + timestamp`. The hash and all check results are appended to the immutable activity log. This creates a tamper-evident audit chain: if anyone modifies a finding after the fact, the hash will not match.

**Report generation:** `evidence.buildReport()` produces a structured markdown report with three sections:
1. **Verified Findings** -- code-checked, evidence-logged, with actual values
2. **Evidence Hashes** -- SHA-256 hashes for cross-referencing against the activity log
3. **Analysis (LLM-generated)** -- clearly labeled as advisory, not verified fact

The LLM formats and analyzes findings but cannot add, remove, or alter them. The `evidence.buildFindingsSummary()` helper produces a plain-text summary of PASS/FAIL results that is given to the LLM for analysis. The LLM never sees or controls the evidence hashes.

### Claim Verifier Service (`services/claim-verifier.js`)

Automatic message tagging for agent claims. Runs on every agent message AFTER security scanning but BEFORE database insert. Deterministic pattern matching only -- no LLM calls, target under 100ms per message.

**What it checks:**
- **File references:** "saved to Intel/report.md" -- verifies the file exists via `fs.existsSync`, records file size and modification time
- **Status claims:** "Lindsey is operational" -- checks the heartbeat table for recent pings
- **Count/quantity claims:** "scanned 47 messages" -- tagged as `self-reported` (not independently verified)

**Verification states:**
- `true` -- independently verified (file exists, heartbeat confirms status)
- `false` -- claim failed verification (file not found, no heartbeat record)
- `self-reported` -- numeric claim that cannot be independently verified
- `deferred` -- path could not be resolved or check failed

The verification result is stored in the message's `metadata.claimVerification` field. The web UI can display trust signals based on this metadata. The verifier never modifies the message body -- it only adds metadata.

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
| `SESSION_SECRET` | **Yes** | Express session encryption key. **Server refuses to start without it.** Also used to derive HMAC keys for lockdown state signing. No fallback, no default. |
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

### Credential Separation (secrets.db)

Darkhan uses two separate SQLite databases for credential isolation:

| Database | File | Permissions | Contains | Accessed by |
|----------|------|-------------|----------|-------------|
| **darkhan.db** | `db/darkhan.db` | 600 | Operational data (users, messages, tasks, activity log) | Server, workers, routes |
| **secrets.db** | `db/secrets.db` | 600 | Credentials only (password hashes, API keys, lockdown PIN hash) | Server and auth middleware **only** |

**Why two databases:** Workers receive the `db` handle (darkhan.db) for operational queries but **never** receive the `secretsDb` handle. This means a compromised worker cannot read password hashes, API keys, or the lockdown PIN hash -- even if it has full database query access to darkhan.db.

The `users` table in darkhan.db contains non-sensitive profile data (username, role, type, display name, status). The `credentials` table in secrets.db contains password hashes and API keys, keyed by `user_id`. The `secret_settings` table in secrets.db stores the lockdown PIN hash.

### darkhan.db Tables

Both databases use SQLite with WAL mode and 5-second busy timeout.

| Table | Purpose | Mutable? |
|-------|---------|----------|
| `users` | Team members -- profile data only (no credentials), includes per-user timezone | Yes |
| `channels` | Communication channels | Yes |
| `messages` | All messages with origin tracking and claim verification metadata | Yes |
| `tasks` | Task assignment and tracking | Yes |
| `agent_heartbeats` | Current status per agent | Yes |
| `agent_health` | Historical health snapshots | Yes |
| `cost_tracking` | Per-agent token/cost accounting | Append only |
| `activity_log` | Immutable audit trail (hash chain with origin, entry_type, CRISPR spacers) | **Append only -- enforced by SQLite triggers** |
| `ground_truths` | Verified facts registry (key, value, aliases, category, source, expiry) | Yes (admin only) |
| `approval_queue` | Pending action approvals | Yes |
| `claude_conversations` | Claude relay history | Yes |
| `settings` | Non-sensitive system settings | Yes |

### secrets.db Tables

| Table | Purpose | Mutable? |
|-------|---------|----------|
| `credentials` | Password hashes and API keys (keyed by user_id) | Yes |
| `secret_settings` | Lockdown PIN hash and other sensitive settings | Yes |

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
| `chief.worker.js` | Chief (Executive Assistant) | daily_briefing, morning_digest, evening_digest, deadline_monitor, heartbeat | 0545/0700/1800/6h/5m |
| `darkhan.worker.js` | Darkhan (Security) | security_sweep, activity_audit, corey_daily_audit, heartbeat | 15m/1h/0100 daily/5m |
| `lindsey.worker.js` | Lindsey (COO) | morning_readiness, inbox_processor, draft_review_check, shift_change, heartbeat | 0630/2h/3h/2100/5m |
| `penny.worker.js` | Penny (CFO/CMO) | morning_business_scan, sttr_monitor, product_exploration, weekly_market_brief, heartbeat | 0800/10+16h/11h weekdays/Mon 0700/5m |

### Corey Daily Security Audit

The `corey_daily_audit` task runs at 0100 ET every day as part of the Darkhan security worker. It is a comprehensive red team review that uses the Evidence Service for every verification:

**What it checks:**
- File permissions on sensitive files (.env, database files)
- Credential exposure in all channels (24-hour lookback)
- Activity log anomalies (injection attempts, lockdown events, shell violations)
- Agent activity volume (flags agents with >1000 actions in 24h)
- Configuration integrity (valid JSON, secure agent settings)
- Integrity baseline existence, age, and permissions

**How it works:**
1. Each check uses `evidence.check()` to produce a tamper-evident finding
2. Findings are summarized and sent to an LLM (Gemini primary, Ollama fallback) playing the Corey red team persona
3. The LLM produces analysis, grading, and GO/NO-GO recommendation
4. `evidence.buildReport()` assembles the final report with verified findings, evidence hashes, and LLM analysis clearly separated
5. The report is saved to `project/output/` and posted to #alerts (and #command if any checks failed)

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
| Tool enforcement | Per-agent shell command restrictions + env whitelist | `security.js` + `worker-runtime.js` |
| Interpreter blocking | `python`, `node`, `perl`, `ruby`, `php` blocked in restricted shell | `security.js` |
| Identity enforcement | Agents cannot impersonate humans or other agents | `middleware/auth.js` |
| Credential isolation | Password hashes, API keys, PIN in separate database | `secrets.db` (not accessible to workers) |
| Claim verification | Agent messages auto-tagged with evidence of claim accuracy | `claim-verifier.js` |
| Evidence-based reporting | Security reports use SHA-256-hashed code-level checks | `evidence.js` |
| Active monitoring | 15-minute automated channel sweeps (evidence-based) | `darkhan.worker.js` |
| Daily red team audit | Comprehensive security review at 0100 ET daily | `darkhan.worker.js` (corey_daily_audit) |
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
- `restricted` -- dangerous commands blocked (rm, sudo, kill, curl to external hosts, ssh, etc.) and interpreter commands blocked (python, node, perl, ruby, php). Command substitution and pipe-to-shell also blocked.
- `none` -- no shell access

**Environment whitelist:** Workers executing shell commands receive only `HOME`, `PATH`, `LANG`, `USER`, and `TERM` environment variables. Secrets (`SESSION_SECRET`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, etc.) are never exposed to worker shell processes.

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
- Lockdown persists across server restarts (stored in database with HMAC signature)
- HMAC is derived from `SESSION_SECRET` with a domain separator -- if the lockdown state is tampered with in the database, the signature will not match and the system **fails closed** (stays locked)
- During lockdown: human messages work normally, agent messages return 403
- Lockdown alerts are posted to #alerts and #command channels
- Only human admin users can lift lockdown via the web UI Settings view
- Agents cannot unlock the system -- this is enforced at the code level, not configuration
- PIN-based unlock adds a second factor to prevent social engineering attacks
- **Fail-closed PIN requirement:** If no lockdown PIN is configured in secrets.db, the system refuses to unlock. You must set a PIN via Settings before you can recover from lockdown.

**Managing lockdown:**
- **Check status:** Open the Settings view in the web UI
- **Manual lockdown:** Available from the Settings view for human admins (requires browser session -- API key auth is rejected for security-critical actions)
- **Unlock:** Requires admin browser session authentication plus lockdown PIN (stored in secrets.db only)

### 3-Layer Security Hardening

Darkhan implements defense in depth across three layers:

**Layer 1: Break-Glass Recovery (`server/break-glass.js`)**
Emergency admin recovery tool for when normal authentication is unavailable. Requires interactive TTY -- blocks scripted, piped, or automated execution. Commands:
- `status` -- check server and lockdown state (no authentication required)
- `reset-password` -- reset an admin password (requires lockdown PIN)
- `lift-lockdown` -- manually lift lockdown (requires lockdown PIN)
- `reset-baseline` -- reset the integrity baseline (requires lockdown PIN)

See [Break-Glass Recovery](#break-glass-recovery) below.

**Layer 2: Service User Privilege Separation**
The `_darkhan` service user owns sensitive files (database, `.env`, integrity baseline, TLS certificates). The Darkhan server process runs as `_darkhan`. Application code stays owned by the developer account. This prevents a compromised developer session from directly accessing secrets.
- Setup: `scripts/setup-service-user.sh`
- launchd template: `scripts/com.darkhan.server.plist`

**Layer 3: macOS Keychain Integration**
Critical secrets (session secret, API keys) are stored in the macOS Keychain rather than in `.env` or the filesystem. Even if an attacker gains read access to the filesystem, secrets remain protected by the Keychain's hardware-backed encryption.
- Setup: `scripts/setup-keychain.sh`
- Service: `services/keychain.js`
- Falls back to `.env` if keychain is not provisioned

### mTLS for Federation

Federated nodes authenticate using mutual TLS (mTLS). Each node presents a client certificate signed by a shared CA. The hub verifies client certificates before accepting federation traffic.

- Certificate generator: `scripts/generate-certs.sh` (creates CA + per-node certs with SAN)
- Server supports HTTPS with client cert verification when `tls.enabled` is set in config
- `FederatedRuntime` and `RemoteRunner` load mTLS certs automatically from configured paths
- Opt-in: federation works over plain HTTP (with `FEDERATION_ALLOW_HTTP`) for development

### Onboarding Security

Every agent receives a verified onboarding brief at startup that includes:
- Their identity and chain of command
- Operating rules they must follow
- Current system state derived from actual configuration
- Explicit statements of what they cannot do (unlock lockdown, impersonate, etc.)

This prevents agents from being misled about their own capabilities or authority.

---

## Break-Glass Recovery

The break-glass tool (`server/break-glass.js`) provides emergency admin access when normal authentication is unavailable -- for example, if you forget your password while the system is in lockdown.

**Usage:**
```bash
cd server
node break-glass.js status           # No auth required -- shows server and lockdown state
node break-glass.js reset-password   # Requires lockdown PIN via interactive prompt
node break-glass.js lift-lockdown    # Requires lockdown PIN via interactive prompt
node break-glass.js reset-baseline   # Requires lockdown PIN via interactive prompt
```

**Security constraints:**
- Requires an interactive TTY. Piped input, scripted execution, and non-TTY environments are rejected.
- PIN is collected via TTY read (not stdin) to prevent capture by process monitors.
- All break-glass actions are logged to the activity log with full attribution.
- The `status` command is the only one that works without authentication.

**When to use it:**
- Locked out after forgetting your password
- Lockdown triggered and you cannot access the web UI
- Integrity baseline corrupted after a legitimate code update
- Recovering after a failed migration or database issue

---

## API Reference

All endpoints require authentication via session cookie (web UI) or `X-API-Key` header (agents/scripts).

### Authentication

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/auth/login` | Login (username + password) |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Current authenticated user |
| POST | `/api/auth/change-password` | Change password (requires current password). Session auth only -- agents cannot call this. Minimum 8 characters. |
| POST | `/api/auth/set-lockdown-pin` | Set or change the lockdown PIN. Admin session auth only. Minimum 4 characters. PIN hash stored in secrets.db. |
| POST | `/api/auth/timezone` | Set user timezone (IANA format, e.g. `America/New_York`). Validated server-side. |

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
| GET | `/api/activity/chain-head` | Hash chain head and entry count |
| GET | `/api/activity/stats` | Chain statistics (entries, spacers, anchors, by origin) |
| GET | `/api/activity/spacers` | List all CRISPR defense spacers |
| POST | `/api/activity/spacers/ingest` | Ingest spacers from a federated instance |

### Ground Truth

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/ground-truth` | List all active ground truth entries |
| POST | `/api/ground-truth` | Add a verified fact (admin only) |
| POST | `/api/ground-truth/:key/deprecate` | Deprecate an entry (admin only) |
| GET | `/api/ground-truth/brief/text` | Plain-text brief for agent consumption |
| POST | `/api/ground-truth/check` | Check a claim for contradictions |

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
- **Settings (admin):** Password change, lockdown PIN setup/change, manual lockdown button, unlock with PIN, lockdown status display with trigger reason and timestamp

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
| Server refuses to start | `SESSION_SECRET` not set | Add `SESSION_SECRET` to `.env`. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| Workers not responding | Ollama not running | `brew services start ollama` then verify with `ollama list` |
| "Cannot connect to database" | Database not initialized | Run `node db/seed.js` |
| Workers not loading | Worker ID mismatch | Ensure `id` in worker file matches `id` in `darkhan.config.json` |
| Workers blocked on startup | Integrity violation detected | Check logs for the violation. If caused by development changes, restart the server to re-establish the baseline |
| Port already in use | Another process on 3001 | Change `PORT` in `.env` or find/kill the conflicting process |
| Remote workers not posting | Network or auth issue | Verify Tailscale connectivity: `ping <hub-tailscale-ip>`. Check API key in remote `.env` |
| `GOOGLE_API_KEY` errors | Env var not set | Add to `.env` on the node running Gemini-powered workers |
| Agent shows red in Health | Worker crashed or not started | Check logs, restart Darkhan |
| Login fails after seed | Password hash not in secrets.db | Re-run `node db/seed.js` to reset. Ensure secrets.db exists in `db/` |
| API key auth fails | secrets.db missing or not migrated | If upgrading from v1, run `node db/seed.js` to populate secrets.db with credentials |
| Lockdown triggered unexpectedly | Auto-lockdown threshold hit | Check activity log (`GET /api/activity?action=lockdown_activated`) for the trigger reason. Unlock via Settings UI |
| Lockdown after file changes | Integrity service detected modifications | Expected during development. Restart the server to re-establish the integrity baseline |
| Cannot unlock -- "no PIN configured" | Lockdown PIN not set in secrets.db | You must set a lockdown PIN via Settings before lockdown can be lifted. If locked out, re-seed the database |
| Cannot unlock -- "signature mismatch" | Lockdown state tampered in database | System fails closed. Re-seed the database to reset lockdown state |
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

Post-v1 additions (2026-03-28):
- **Credential separation:** secrets.db isolates password hashes, API keys, and lockdown PIN from the operational database. Workers cannot access credentials.
- **Evidence-based reporting:** EvidenceService produces SHA-256-hashed, tamper-evident findings for all security reports. LLM analysis clearly separated from verified facts.
- **Claim verification:** ClaimVerifierService auto-tags agent messages with evidence of whether file references, status claims, and numeric assertions check out.
- **Corey daily audit:** Comprehensive red team security review at 0100 ET using evidence-based checks and LLM analysis (Gemini primary, Ollama fallback).
- **Hardened security:** SESSION_SECRET required (no fallback), HMAC-signed lockdown state with fail-closed tamper detection, lockdown PIN fail-closed (must be set before unlock works), interpreter commands blocked in restricted shell, environment whitelist for worker shell processes.

Post-v1 additions (2026-03-29):
- **Hash chain with CRISPR defense spacers:** Activity log entries include origin (instance ID), entry_type (event/spacer/anchor). Defense spacers auto-created on injection, lockdown, and exfiltration events. Chain anchors for periodic integrity checkpoints. 6 federation-ready API endpoints.
- **Ground Truth Registry:** 15 verified facts with 43 aliases. Contradiction detection integrated into claim verifier pipeline. Admin API for managing canonical facts.
- **Output Verification Gate:** Ground truth + claim verifier pipeline = never-lie architecture core.
- **Break-glass recovery:** Emergency admin recovery tool requiring interactive TTY + lockdown PIN. Commands: status, reset-password, lift-lockdown, reset-baseline.
- **3-layer security hardening:** Layer 1 (break-glass TTY enforcement), Layer 2 (_darkhan service user privilege separation), Layer 3 (macOS Keychain secret storage).
- **mTLS for federation:** CA + per-node certificates with SAN. Mutual TLS verification on federation traffic.
- **Native macOS sandbox:** Environment whitelist, filesystem deny-list, resource watchdog, sandbox-exec SBPL profile generation.
- **Per-user timezone:** IANA timezone per user, served on login, validated server-side.
- **Forge branding:** "Darkhan -- The Forge" throughout UI, manifest, and documentation.
- **Threat flag capability:** `darkhan.flagThreat()` available to all workers. Posts structured alert + creates CRISPR spacer.
- **Session invalidation on password change:** Destroys all other sessions for the user.
- **Chief daily briefing:** 0545 ET consolidated overnight report saved to `project/cos/Daily-Briefings/`.
- **Private GitHub repo:** `outlaw4shrt/darkhan`, community docs (SECURITY.md, CONTRIBUTING.md, issue/PR templates).
