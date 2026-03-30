# Darkhan

**An AI agent command center built on the principle that agents should be architecturally incapable of lying.**

Darkhan coordinates AI agents and humans from a single deployable Node.js server. Every agent message is evidence-checked, every action is hash-chained into an immutable audit trail, and every credential is isolated from agent access. If your agents hallucinate, fabricate, or go rogue -- you will know, and the system will shut them down.

---

## What Makes Darkhan Different

Most agent frameworks trust the agent. Darkhan does not.

**Agents prove their claims.** Every factual assertion an agent makes is automatically verified against the filesystem, heartbeat data, or a ground truth registry. Claims are tagged as `verified`, `unverified`, or `self-reported` before they reach you.

**Immutable audit trail.** Every action -- LLM calls, file writes, shell commands, security events -- is logged to a SHA-256 hash chain. SQLite triggers prevent deletion or modification. You can cryptographically verify the entire chain end-to-end.

**Credential isolation by design.** Passwords, API keys, and PINs live in a separate database that agent workers never receive a handle to. A compromised agent cannot read credentials, period.

**Identity enforcement.** Agents cannot impersonate humans or each other. Attempts are silently corrected, logged, and trigger automatic lockdown.

**$0/day local LLM.** Triage, classification, and routine agent work runs on Ollama (Qwen 2.5 14B by default) locally. Cloud APIs (Gemini, Anthropic) are available for heavier tasks. You control the cost.

**Federation across machines.** Run workers on multiple nodes with a single hub. Workers use the same code locally or remotely -- the runtime handles the difference transparently.

---

## Quick Start

**Requirements:** Node.js 18+, npm, Ollama (recommended for local LLM)

```bash
# Clone the repo
git clone https://github.com/outlaw4shrt/darkhan.git
cd darkhan/server

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env -- at minimum, set SESSION_SECRET:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Edit darkhan.config.json to define your team (agents, channels, schedules)

# Initialize the database
node db/seed.js

# Enable the pre-commit secret scanner
git config core.hooksPath .githooks

# Start
node server.js
```

Open `http://localhost:3001`. Log in with the default credentials from your config. **Change your password immediately** via Settings.

For detailed setup including Ollama, launchd, and multi-node federation, see [SETUP.md](SETUP.md).

---

## Architecture

```
darkhan/
  server/
    server.js              # Express app entry point
    darkhan.config.json    # Team config: agents, humans, channels, schedules, permissions
    .env                   # Secrets (never committed)
    db/                    # SQLite databases (darkhan.db + secrets.db)
    routes/                # REST API (auth, messages, tasks, health, vault, security)
    services/              # Core services (see below)
    workers/               # Agent worker definitions (your agents live here)
    middleware/             # Auth, identity enforcement
    break-glass.js         # Emergency admin recovery (TTY-only)
    model-verifier.js      # LLM model integrity verification
  client/                  # Web UI (vanilla JS, dark theme, PWA)
  .githooks/               # Pre-commit secret scanner
```

**Core services:**

| Service | Purpose |
|---------|---------|
| `llm.js` | Unified LLM interface (Ollama, Gemini, Anthropic) with automatic rate limiting and cost tracking |
| `security.js` | Injection detection, identity enforcement, leak prevention, auto-lockdown |
| `integrity.js` | File hash monitoring, config checksum, tamper detection |
| `activity-log.js` | Immutable hash chain audit trail with CRISPR defense spacers |
| `evidence.js` | SHA-256-hashed evidence-based reporting for agent claims |
| `claim-verifier.js` | Automatic verification tagging on every agent message |
| `ground-truth.js` | Canonical registry of verified facts; contradiction detection |
| `onboarding.js` | Injects verified identity and rules into every agent at startup |
| `worker-runtime.js` | Cron scheduling, task execution, listener dispatch |
| `federated-runtime.js` | Cross-node HTTP federation for distributed workers |
| `sandbox.js` | Native macOS process isolation (sandbox-exec profiles) |
| `tool-executor.js` | Sandboxed tool execution with injection scanning and rate limits |
| `cost-tracker.js` | Per-agent token and cost accounting (integer millicents) |
| `rate-limiter.js` | Two-level rate limiting (per-provider, per-agent) |

---

## Security Model

Security is foundational, not bolted on. Darkhan assumes a hostile environment where prompt injection through the message chain is the primary attack vector.

### Defense Layers

**Input/Output Scanning**
- Regex + local LLM classification on all incoming messages
- Tool output injection scanning on `fs.read()` and `shell.exec()` before results reach the LLM context
- Outbound leak prevention scans for API keys, passwords, private keys

**Agent Containment**
- Per-agent file write permissions (agents can only write to designated directories)
- Shell command restrictions (dangerous commands, interpreters, pipe-to-shell all blocked)
- Tool invocation rate limits (200 reads, 50 writes, 10 shell execs per task)
- Network egress deny-default policy (only Ollama, Gemini API, Anthropic API allowed)
- Environment variable whitelist (secrets never exposed to worker shell processes)
- Process isolation via `fork()` with IPC-only communication

**Trust Verification**
- Evidence-based reporting with SHA-256 hashes binding claims to their verification method and result
- Ground truth registry with automatic contradiction detection
- Claim verifier tags every agent message before storage
- LLM model file integrity verification at startup

**Audit and Recovery**
- Immutable hash chain with CRISPR defense spacers marking security events
- File integrity monitoring (SHA-256 baseline, verified every 5 minutes)
- Automatic lockdown on impersonation, repeated injection, data leaks, or integrity violations
- Human-only unlock with PIN (agents architecturally cannot lift lockdown)
- Break-glass recovery tool requiring interactive TTY + PIN

### 3-Layer Credential Hardening

| Layer | Mechanism |
|-------|-----------|
| 1 | Break-glass recovery requires interactive TTY -- blocks scripted or automated access |
| 2 | `_darkhan` service user owns sensitive files; application code runs under a separate account |
| 3 | macOS Keychain stores secrets outside the filesystem entirely |

### Lockdown

Security events trigger automatic lockdown. All agent traffic stops. Only a human admin can unlock via the web UI with a PIN. Lockdown state is HMAC-signed -- database tampering causes the system to fail closed (stay locked).

For full details, see [SECURITY.md](SECURITY.md).

---

## Features

**Agents and Workers**
- Define agents as JavaScript modules with scheduled tasks and message listeners
- Workers receive `llm`, `darkhan`, `tools`, `config`, `log` interfaces from the runtime
- Cron scheduling, error isolation, timeout enforcement
- Sequential within a worker, parallel across workers
- Onboarding service injects verified identity into every LLM call

**Communication**
- Channel-based messaging (create channels for any purpose)
- Real-time WebSocket updates (Socket.IO)
- Auto-responder with two-tier routing: local LLM triage then cloud escalation
- Telegram bridge (optional) for external stakeholders

**LLM Support**
- Ollama (local, $0): Qwen 2.5 14B or any Ollama model
- Google Gemini: pay-per-use for agent workers
- Anthropic Claude: pay-per-use for strategic tasks
- Per-agent rate limits are user-configurable (set `requestsPerDay: 0` for unlimited)
- Two-level rate limiting: per-provider global limits and per-agent limits
- Cost tracking with per-agent breakdowns

**Knowledge Base (Vault)**
- File browser with markdown rendering
- Full-text search across the vault
- File create, edit, delete via API and web UI
- Per-agent write permissions

**Web UI**
- Vanilla JS SPA, dark theme, no framework dependencies
- Channels, tasks, agent health dashboard, vault browser, cost reporting
- Admin settings: lockdown control, password management, PIN setup
- PWA with service worker

**Federation**
- Hub + remote worker architecture
- Workers use identical code locally or remotely
- Authenticated via per-agent API keys
- mTLS support for inter-node encryption
- CRISPR defense spacers propagate across federated instances

**Observability**
- Agent health dashboard (green/amber/red status lights)
- Activity log with hash chain verification API
- Cost tracking by agent, provider, model, and date
- Worker status and last-run reporting
- Security event summary API

---

## Writing a Worker

Workers are JavaScript modules in `server/workers/`. Here is the minimal structure:

```javascript
module.exports = {
  id: 'agent_myagent',      // Must match an entry in darkhan.config.json
  name: 'My Agent',

  async onLoad({ darkhan, log }) {
    log.info('Worker loaded');
    await darkhan.post('chan_command', 'My Agent online.');
  },

  tasks: {
    my_task: {
      schedule: '0 */4 * * *',   // Every 4 hours
      timeout: 300000,
      async run({ llm, darkhan, tools, log }) {
        const data = await tools.fs.read('project/status.md');
        const result = await llm.complete({
          messages: [{ role: 'user', content: `Summarize: ${data}` }],
        });
        await darkhan.post('chan_command', result.response);
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

Add the agent to `darkhan.config.json`, restart Darkhan, and the worker loads automatically.

For the complete runtime contract -- interfaces, permissions, error handling, testing, federation -- see [WORKER-CONTRACT.md](WORKER-CONTRACT.md).

---

## API Overview

All endpoints require authentication via session cookie or `X-API-Key` header.

| Area | Key Endpoints |
|------|--------------|
| Auth | `POST /api/auth/login`, `/logout`, `/change-password`, `/set-lockdown-pin` |
| Messages | `GET /api/messages`, `POST /api/messages` |
| Tasks | `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id` |
| Health | `GET /api/health/status`, `POST /api/health/ping`, `GET /api/workers` |
| Vault | `GET /api/vault/tree`, `GET /api/vault/file`, `PUT /api/vault/file`, `GET /api/vault/search` |
| Security | `GET /api/security`, `POST /api/security/lockdown`, `POST /api/security/unlock` |
| Activity | `GET /api/activity`, `GET /api/activity/chain-head`, `GET /api/activity/stats` |
| Ground Truth | `GET /api/ground-truth`, `POST /api/ground-truth`, `POST /api/ground-truth/check` |
| Costs | `GET /api/costs/daily`, `GET /api/costs/total` |

WebSocket events: `new_message`, `task_update`, `agent_health`, `delete_message`.

---

## Deployment

**Single node** -- one machine runs the server and all workers:
```bash
cd server && node server.js
```

**Multi-node (federated)** -- one hub, remote workers on other machines:
1. Hub runs `server.js` (database, web UI, local workers)
2. Remote nodes run `remote-runner.js` (workers post results to hub via HTTP API)
3. Nodes connect over Tailscale or any private network (mTLS available for encryption without VPN)

No public internet exposure required. Darkhan is designed for private networks.

See [SETUP.md](SETUP.md) for launchd configuration, service user setup, and Keychain provisioning.

---

## Platform Support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon) | Supported -- full feature set including native sandbox |
| macOS (Intel) | Supported |
| Linux | Planned -- sandbox-exec equivalent not yet implemented |
| Windows | Planned |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Security vulnerabilities:** Do not open a public issue. Email the address in [SECURITY.md](SECURITY.md) for responsible disclosure.

---

## License

Darkhan is licensed under the [Business Source License 1.1](LICENSE).

- **Free for non-production use**, internal use, development, and evaluation
- **Production use** requires a commercial license from the licensor
- The licensed code converts to a fully open-source license (Apache 2.0) on the change date specified in the license file

**Mokume** (enterprise federation layer for connecting multiple Darkhan instances across an organization) is a separate commercial product.

---

## Background

The name comes from Mongolian/Turkic: a *darkhan* is a master craftsman whose skill earned them autonomy. The forge is where craftsmen work. Each team member -- human or agent -- is a craftsman with a defined specialty. Darkhan is the forge that coordinates them.

Built by [Outlaw Motor Company](https://github.com/outlaw4shrt). Evolved from five iterations of an internal command center (2026), then rebuilt from scratch with security as the foundation.
