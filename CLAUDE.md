# Darkhan — AI Agent Onboarding Guide

> This file is read automatically by Claude Code and similar AI coding assistants.
> It gives your agent the context it needs to be effective in Darkhan from the first message.
>
> **For teams:** Copy this file as a starting point, then add your own team-specific
> sections (chain of command, agent personas, channel purposes, deployment details).
> See the "Customization" section at the bottom for a template.

---

## What Is Darkhan

Darkhan is an AI agent command center built on the principle that **agents should be architecturally incapable of lying**. It provides:

- **Evidence-based reporting** — agents can't claim actions without system-captured proof
- **Immutable audit trail** — SHA-256 hash chain, append-only, no delete/update
- **Credential isolation** — API keys stored in a separate encrypted database, never in agent memory
- **Identity enforcement** — agents authenticate as themselves, impersonation is architecturally blocked
- **Local LLM triage** — routine messages handled by Ollama ($0), complex work escalated to cloud LLMs
- **Multi-node federation** — Mokume protocol connects Darkhan instances across machines

Darkhan is not a chatbot wrapper. It is a supervision and coordination platform for teams of humans and AI agents working together on real tasks with real consequences.

## Startup Protocol

Every new agent session starts cold. You do not know what the previous instance did, claimed, or broke.

### Step 1: Orient yourself

1. Read this file (you're doing that now)
2. Read `darkhan.config.json` — your team, channels, and agent configuration
3. Check server health: `curl -s http://localhost:3001/api/health/status`
4. Check your onboarding brief: `curl -s http://localhost:3001/api/context/brief -H "X-API-Key: YOUR_KEY"`

### Step 2: Verify, don't assume

- Check what services are actually running before claiming they are
- Check recent messages in your channels to understand current context
- If a state file exists, read it — but verify its claims against reality

### Step 3: Report honestly

Tell your human operator:
- What you verified is actually running
- What you could NOT verify (and why)
- Any discrepancies between documentation and reality

**The cardinal rule: Never claim something is deployed, operational, or complete unless you have verified it yourself in this session.**

## How to Communicate

### Posting to channels

All communication goes through the Darkhan API. You authenticate with your API key in the `X-API-Key` header.

```bash
curl -s -X POST http://localhost:3001/api/messages \
  -H "Content-Type: application/json" \
  -H "X-Darkhan-Client: true" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"channel_id":"chan_command","body":"Your message here","type":"message"}'
```

Required headers:
- `Content-Type: application/json`
- `X-Darkhan-Client: true` (CSRF protection)
- `X-API-Key: YOUR_KEY` (agent authentication)

### Reading messages

```bash
# Recent messages from a channel
curl -s "http://localhost:3001/api/messages?channel=chan_command&limit=20" \
  -H "X-API-Key: YOUR_API_KEY"

# Messages since a timestamp
curl -s "http://localhost:3001/api/messages?channel=chan_command&since=2026-04-07T00:00:00Z" \
  -H "X-API-Key: YOUR_API_KEY"
```

### Chat-terminal bridge

If you're running in an integrated terminal inside Darkhan, messages from the web UI chat are routed to your terminal session by the auto-responder. They arrive prefixed with:

```
[Chat message from user_name in chan_channel]: message content
```

When you receive these, respond both in the terminal AND post back to the channel via the API so your response appears in the web UI.

### Your API key

Your API key is stored encrypted (AES-256-GCM) in `server/db/secrets.db`. It was generated during setup and is tied to your agent identity. You can retrieve it programmatically:

```javascript
// Node.js — decrypt your API key from secrets.db
const crypto = require('crypto');
const fs = require('fs');
const sqlite3 = require('sqlite3');

const env = fs.readFileSync('server/.env', 'utf8');
const secret = env.match(/SESSION_SECRET=(.+)/)[1].trim();
const key = crypto.hkdfSync('sha256', secret, 'darkhan-secrets-enc', 'encryption', 32);

const db = new sqlite3.Database('server/db/secrets.db');
db.get('SELECT api_key FROM credentials WHERE user_id = ?', ['YOUR_AGENT_ID'], (err, row) => {
  const [ivB64, ctB64, tagB64] = row.api_key.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plainKey = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final()
  ]).toString('utf8');
  console.log(plainKey); // dk_agent_...
  db.close();
});
```

Replace `YOUR_AGENT_ID` with your agent ID from `darkhan.config.json` (e.g., `agent_claude`).

## Key Concepts

### Evidence-based reporting

Darkhan enforces a 15-verb controlled vocabulary for agent actions. Each verb maps to system-captured evidence:

| Verb | Evidence Type | Example |
|------|--------------|---------|
| `created` | `fs.stat` on new file | "Created config.json" |
| `deployed` | Process check (`pgrep`) | "Deployed worker service" |
| `verified` | Test output or hash check | "Verified API endpoint returns 200" |
| `observed` | System metric snapshot | "Observed CPU at 85%" |

Agents cannot use these verbs without the system capturing corresponding evidence. If you say "deployed X" but the process isn't running, the claim is tagged `unverified`.

### Trust levels

Every message carries a trust level, determined server-side (never by the client):

| Level | Meaning |
|-------|---------|
| `human_verified` | From an authenticated human session |
| `agent_local` | From a local agent with a valid API key |
| `agent_federated` | From a remote agent via Mokume federation |
| `external` | From an external integration (Telegram, etc.) |
| `quarantined` | Flagged by two-LLM consensus as potentially injected |

### Message routing tiers

The auto-responder classifies incoming messages and routes them:

| Tier | Handler | When |
|------|---------|------|
| `heartbeat_log` | Log only | System heartbeats |
| `local_llm` | Ollama (local, $0) | Routine: greetings, status checks, short confirmations |
| `claude_relay` | Cloud LLM / unified session | Complex analysis, code work, `@claude`, `/claude` prefix |

Force routing with prefixes: `/quick` for local LLM, `/claude` or `/deep` for cloud relay.

### Workers

Workers are autonomous agent modules with scheduled tasks and message listeners. They run crash-isolated with sandboxed access to:

- `evidence` — structured claim verification
- `llm` — rate-limited LLM access
- `darkhan` — post messages, create tasks, flag threats
- `tools` — controlled file/shell/web access
- `observe` — signal-interpretation separated observations
- `config` — read-only agent configuration

See `WORKER-CONTRACT.md` for the full runtime contract and `server/workers/examples/` for templates.

### Ground truth registry

Verified facts that agents must reference instead of hallucinating. Managed via the API:

```bash
# Get all ground truths
curl -s http://localhost:3001/api/ground-truth -H "X-API-Key: YOUR_KEY"

# Check a claim against ground truths
curl -s -X POST http://localhost:3001/api/ground-truth/check \
  -H "Content-Type: application/json" \
  -H "X-Darkhan-Client: true" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{"text":"The system efficiency is 47%"}'
```

## Architecture Reference

### Server directory structure

```
server/
  server.js              # Main entry point — initializes all services
  darkhan.config.json    # Team, channels, agents, LLM providers, federation
  .env                   # Secrets (SESSION_SECRET, API keys for LLM providers)
  db/
    darkhan.db           # Main database (messages, users, tasks, activity log)
    secrets.db           # Credential store (API keys, encrypted at rest)
  services/
    auto-responder.js    # Message classification and routing (local LLM vs cloud)
    unified-claude.js    # Shared session between chat UI and terminal
    terminal-relay.js    # xterm.js terminal ↔ Claude session bridge
    security.js          # Input scanning, content normalization, injection detection
    federation.js        # Mokume hub connectivity and message relay
    activity-log.js      # Immutable SHA-256 hash chain audit log
    evidence.js          # Structured evidence capture for agent claims
    worker-runtime.js    # Worker module loader, scheduler, crash isolation
    llm.js               # Unified LLM interface (Ollama, Gemini, Claude, GPT)
    cost-tracker.js      # Per-agent token usage accounting
    rate-limiter.js      # Per-agent and provider-level rate limiting
    behavioral-baseline.js  # Agent activity anomaly detection
    integrity.js         # File and database tamper monitoring
    sandbox.js           # OS-level worker process isolation
    instance-identity.js # Ed25519 keypair for federation trust
    claim-verifier.js    # Scans messages for verifiable claims
    ground-truth.js      # Verified facts registry
    review-gate.js       # Optional LLM-based output verification
    secrets-crypto.js    # AES-256-GCM encryption for credentials at rest
    onboarding.js        # Agent startup brief generation
    telegram.js          # Telegram bridge integration
  routes/
    messages.js          # POST/GET messages API
    tasks.js             # Task CRUD
    auth.js              # Login, logout, password management
    health.js            # Agent health dashboard
    approvals.js         # Human approval queue for sensitive actions
    quarantine.js        # Two-LLM consensus disagreement queue
    context.js           # Agent onboarding briefs and state files
    folio.js             # Knowledge base file management with search
  workers/
    darkhan.worker.js    # Built-in security officer (message scanning, anomaly detection)
    examples/            # Worker templates (assistant, security, telegram, adversary)
  middleware/
    auth.js              # Session + API key authentication with identity locking
  mcp-server/
    index.js             # MCP bridge for Claude Code CLI integration
  scripts/
    incident-snapshot.js # Emergency forensic capture
    secret-scanner.js    # Hardcoded credential detection
    siege-pass3.js       # Security pipeline test suite (32 injection payloads)
  client/                # React web UI (chat, terminal, tasks, workers, costs, approvals)
```

### Key API endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/messages` | GET/POST | Read and send messages |
| `/api/tasks` | GET/POST/PUT/DELETE | Task management |
| `/api/health/status` | GET | Agent health dashboard |
| `/api/health/report` | POST | Agent health self-report |
| `/api/activity` | GET | Audit log with pagination |
| `/api/activity/verify` | GET | Hash chain integrity check |
| `/api/costs/daily` | GET | Cost breakdown by provider |
| `/api/ground-truth` | GET/POST/PUT/DELETE | Verified facts registry |
| `/api/context/brief` | GET | Agent onboarding brief |
| `/api/folio` | GET/POST/PUT/DELETE | Knowledge base files |
| `/api/approvals` | GET/POST | Human approval queue |
| `/api/quarantine` | GET | Two-LLM disagreement queue |
| `/api/diagnostic` | GET | System state (zero-auth) |
| `/api/security` | GET | Security summary |
| `/api/workers` | GET | Worker runtime status |

### Security model

- **Identity enforcement:** Your agent ID is determined by your API key, server-side. You cannot post as anyone else. The server rejects impersonation attempts and logs them as security events.
- **Credential isolation:** API keys live in `secrets.db`, encrypted with AES-256-GCM. The main database never stores credentials.
- **Input scanning:** All messages pass through content normalization (strips Unicode tricks, zero-width characters, RTL overrides, decodes base64) and regex pattern detection before processing.
- **Two-LLM consensus:** Suspicious messages are evaluated by both the local LLM and cloud provider. Disagreements go to a quarantine queue for human review.
- **Behavioral baselines:** Agent activity patterns are tracked. 3x deviations trigger alerts.
- **Lockdown:** Configurable fail-closed mode that blocks all agent traffic. PIN-protected recovery.

### Federation (Mokume)

Darkhan instances connect to each other via the Mokume federation protocol:

- **Hub-spoke topology:** One hub, multiple spokes
- **Ed25519 message signing:** All federated messages are cryptographically signed
- **Channel-scoped:** Only configured channels federate (typically `#coordination` and `#alerts`)
- **Loop prevention:** Messages carry origin tags to prevent infinite relay loops
- **Threat propagation:** Security events propagate across the federation (CRISPR-style defense spacers)

## Common Patterns

### Responding to chat from terminal

When you see `[Chat message from USER in CHANNEL]: ...`, always:

1. Process and respond in the terminal (your operator may be watching)
2. Post your response back to the channel via the API

### Checking what's running

```bash
# Server health
curl -s http://localhost:3001/api/health/status | jq .

# System diagnostic (no auth required)
curl -s http://localhost:3001/api/diagnostic | jq .

# Worker status
curl -s http://localhost:3001/api/workers -H "X-API-Key: YOUR_KEY" | jq .

# Audit log integrity
curl -s http://localhost:3001/api/activity/verify -H "X-API-Key: YOUR_KEY" | jq .
```

### Writing a minimal worker

```javascript
// workers/my-agent.worker.js
module.exports = {
  id: 'agent_myagent',
  name: 'My Agent',
  channel: 'chan_myagent',

  onLoad({ log }) {
    log.info('Agent loaded');
  },

  tasks: [
    {
      name: 'daily-check',
      schedule: '0 9 * * *', // 9 AM daily
      async run({ darkhan, evidence, log }) {
        const result = await evidence.capture('verified', 'API health check', {
          type: 'http',
          url: 'http://localhost:3001/api/diagnostic'
        });
        await darkhan.post(this.channel, `Morning check: ${result.status}`);
      }
    }
  ],

  listeners: [
    {
      name: 'mention-responder',
      match: ({ body }) => /\bmyagent\b/i.test(body),
      async handle({ channel, from, body }, { darkhan, llm, log }) {
        const response = await llm.ask(`Respond to: ${body}`);
        await darkhan.post(channel, response);
      }
    }
  ]
};
```

Register in `darkhan.config.json` under `team.members` and restart the server.

## Customization

Teams should add their own sections to this file. Here's a starting template:

```markdown
## Team — [Your Organization]

### Chain of Command
1. [Human operator] — final decision authority
2. [Lead agent] — coordinates work, maintains state
3. [Agent 2] — specific domain
4. [Agent 3] — specific domain

### Agent Personas
Each agent should know who they are and what they're responsible for.
Define per-agent CLAUDE.md files or add persona sections here.

### Channels
| Channel | Purpose | Who uses it |
|---------|---------|-------------|
| #command | Primary operator channel | Human + lead agent |
| #coordination | Cross-agent coordination | All agents |
| #alerts | System alerts | Automated |

### State Management
Describe where your team's state documents live and who maintains them.

### Deployment
- Node count and locations
- Federation topology
- LLM provider configuration
```

## Documentation Index

| Document | Purpose |
|----------|---------|
| `README.md` | Product overview, architecture, quick start |
| `SETUP.md` | Installation, configuration, deployment guide |
| `SECURITY.md` | Threat model, defense layers, hardening guide |
| `WORKER-CONTRACT.md` | Complete worker runtime API and contract |
| `docs/ADVERSARIAL-TESTING-REPORT.md` | Security test results (32 payloads, 100% blocked) |
