# Darkhan

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-orange.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![macOS](https://img.shields.io/badge/Platform-macOS-blue.svg)](https://www.apple.com/macos/)
[![GitHub Discussions](https://img.shields.io/github/discussions/5RIndustries/darkhan)](https://github.com/5RIndustries/darkhan/discussions)

**An AI agent command center built on the principle that agents should be architecturally incapable of lying.**

Darkhan coordinates AI agents and humans from a single deployable Node.js server. Every agent message is evidence-checked, every action is hash-chained into an immutable audit trail, and every credential is isolated from agent access. If your agents hallucinate, fabricate, or go rogue -- you will know, and the system will shut them down.

---

## What Makes Darkhan Different

Most agent frameworks trust the agent. Darkhan does not.

**Agents prove their claims.** Every factual assertion an agent makes is automatically verified against the filesystem, heartbeat data, or a ground truth registry. Claims are tagged as `verified`, `unverified`, or `self-reported` before they reach you.

**Immutable audit trail.** Every action -- LLM calls, file writes, shell commands, security events -- is logged to a SHA-256 hash chain. SQLite triggers prevent deletion or modification. You can cryptographically verify the entire chain end-to-end.

**Credential isolation by design.** Passwords, API keys, and PINs live in a separate database that agent workers never receive a handle to. A compromised agent cannot read credentials, period.

**Identity enforcement.** Agents cannot impersonate humans or each other. Attempts are silently corrected, logged, and trigger automatic lockdown.

**$0/day local LLM.** Triage, classification, and routine agent work runs locally via native inference (node-llama-cpp with Metal GPU acceleration on Apple Silicon). Qwen 2.5 7B is the default — runs comfortably on any Mac with an M-series chip and 16GB RAM. Four cloud providers supported (Google Gemini, Anthropic Claude, OpenAI GPT) for heavier tasks and cross-provider consensus. You choose every model. You control the cost.

**Action-Evidence Protocol.** Every tool call produces system-captured evidence (file hashes, PIDs, exit codes, search results). Agent messages are evaluated against their evidence trail and tagged: verified, partial, claimed, or contradicted. Agents can say whatever they want — the evidence trail is immutable. Cross-provider claim verification sends the evidence trail to two independent LLMs for consensus.

**Observation-Evidence Protocol.** System observations (process state, resource pressure, behavioral patterns) are recorded with mandatory signal-interpretation separation. Every observation requires an alternative interpretation — the system enforces intellectual humility. Confidence is computed from signal count, not self-assessment.

**Federation across machines.** Run workers on multiple nodes with a single hub. Workers use the same code locally or remotely -- the runtime handles the difference transparently.

**Adversarial tested.** Before public release, Darkhan was subjected to a structured adversarial test: 32 semantic injection payloads across 8 categories (social engineering, authority pressure, multilingual attacks, competitive intelligence framing, and more). The two-LLM consensus pipeline blocked or quarantined 100% of payloads. Full methodology and results: [Adversarial Testing Report](docs/ADVERSARIAL-TESTING-REPORT.md).

---

## Quick Start

**Requirements:** Node.js 20.12+, npm, 16GB+ RAM, Ollama (for local LLM model files)

```bash
# Clone the repo
git clone https://github.com/5RIndustries/darkhan.git
cd darkhan

# Run the interactive setup wizard
node setup.js
```

The setup wizard handles everything: checks prerequisites, creates your `.env` and config, copies an example worker for your chosen agent, pulls the local LLM, seeds the database, cleans stale databases from previous failed runs, and starts the server. It auto-detects your system timezone, defaults to in-process workers (not forked), and auto-opens your browser when the server is ready (macOS and Linux).

**First login:** The default password is `changeme`. On first login, Darkhan forces you through a gated setup flow -- you must change your password, then set a lockdown PIN. You cannot access the app until both are complete. No need to find Settings manually.

For manual setup, Ollama configuration, launchd auto-start, and multi-node federation, see [SETUP.md](SETUP.md).

---

## Architecture

```
                     ┌───────────────────────────────────────────┐
                     │            Darkhan Web UI                 │
                     ├──────────┬──────────┬─────────────────────┤
                     │ Channels │ Terminal │ Dashboard/Folio/... │
                     └────┬─────┴────┬─────┴─────────────────────┘
                          │          │
                     Socket.IO   Socket.IO /terminal
                          │          │
              ┌───────────┴──────────┴───────────┐
              │         Darkhan Server            │
              │                                   │
              │  ┌─────────────────────────────┐  │
              │  │   UnifiedClaudeSession       │  │
              │  │   (one Claude per user,      │  │
              │  │    shared across terminal    │  │
              │  │    and chat interfaces)      │  │
              │  └─────────────────────────────┘  │
              │                                   │
              │  ┌──────────┐  ┌───────────────┐  │
              │  │ Workers  │  │ Terminal Relay │  │
              │  │ (agents) │  │ (PTY/SDK)     │  │
              │  └──────────┘  └───────────────┘  │
              │                                   │
              │  Security ─ Evidence ─ Hash Chain  │
              └───────────────────────────────────┘
```

```
darkhan/
  server/
    server.js              # Express app entry point
    darkhan.config.json    # Team config: agents, humans, channels, schedules, permissions
    .env                   # Secrets (never committed)
    db/                    # SQLite databases (darkhan.db + secrets.db)
    routes/                # REST API (auth, messages, tasks, health, folio, security)
    services/              # Core services (see below)
    workers/               # Agent worker definitions (your agents live here)
    middleware/             # Auth, identity enforcement
    break-glass.js         # Emergency admin recovery (TTY-only)
    scripts/               # Secret scanner, service user setup, cert generation
  client/                  # Web UI (vanilla JS, dark theme, PWA)
    terminal-popout.html   # Pop-out terminal window for multi-monitor setups
  scripts/                 # Pre-commit hook, install helpers
  .github/workflows/       # CI pipeline (lint, audit, secret scan, smoke test)
  .npmignore               # Defensive publish filter (prevents Anthropic-class leaks)
```

**Core services:**

| Service | Purpose |
|---------|---------|
| `llm.js` | Unified LLM interface (Ollama, Gemini, Anthropic, OpenAI) with automatic rate limiting and cost tracking |
| `action-evidence.js` | Action-Evidence Protocol — 15-verb controlled vocabulary, system-captured evidence, automatic claim downgrade, cross-provider claim verification |
| `observation-evidence.js` | Observation-Evidence Protocol — signal-interpretation separation for system observations, mandatory alternative interpretations, confidence scoring |
| `security.js` | Injection detection, identity enforcement, leak prevention, auto-lockdown |
| `integrity.js` | File hash monitoring, config checksum, tamper detection |
| `activity-log.js` | Immutable hash chain audit trail with CRISPR defense spacers |
| `evidence.js` | SHA-256-hashed evidence-based reporting for agent claims |
| `claim-verifier.js` | Automatic verification tagging on every agent message |
| `ground-truth.js` | Canonical registry of verified facts; contradiction detection |
| `onboarding.js` | Injects verified identity and rules into every agent at startup |
| `worker-runtime.js` | Cron scheduling, task execution, listener dispatch, Google Workspace tools, complete activity logging |
| `unified-claude.js` | Single Claude SDK session shared between terminal and chat interfaces |
| `terminal-relay.js` | WebSocket relay for Claude Code and shell terminals in the browser |
| `auto-responder.js` | Two-tier message routing: local LLM triage, Claude escalation, unified session bridge, slash commands |
| `review-gate.js` | Optional output verification — local LLM reviews Claude responses for unverified claims and hallucinations before posting |
| `federated-runtime.js` | Cross-node HTTP federation for distributed workers |
| `sandbox.js` | Native macOS process isolation (sandbox-exec profiles) |
| `tool-executor.js` | Sandboxed tool execution with injection scanning and rate limits |
| `cost-tracker.js` | Per-agent token and cost accounting (integer millicents) |
| `rate-limiter.js` | Two-level rate limiting (per-provider, per-agent) |
| `secrets-crypto.js` | AES-256-GCM encryption for API keys at rest, HMAC-indexed lookups |
| `session-store.js` | Custom SQLite session store (replaces connect-sqlite3 to eliminate transitive vulnerability chain) |
| `maintenance.js` | Startup cleanup, orphan process detection, stale heartbeat purging, daily DB hygiene |
| `behavioral-baseline.js` | Per-agent anomaly detection: message, LLM, shell, and channel baselines |
| `instance-identity.js` | Ed25519 keypair per instance, message signing for federation readiness |
| `model-verifier.js` | SHA-256 verification of local Ollama model files against manifests |
| `agent-relay.js` | Claude Agent SDK relay with programmatic tool gating and session persistence |
| `keychain.js` | macOS Keychain integration for Layer 3 credential storage |
| `permissions.js` | Permission management with file path allowlists and blocklists |
| `telegram.js` | Telegram bridge for external stakeholder communication (optional) |
| `worker-process.js` | Child process handler for forked worker agents with IPC protocol |

---

## Security Model

Security is foundational, not bolted on. Darkhan assumes a hostile environment where prompt injection through the message chain is the primary attack vector.

### Threat Model

Darkhan is designed to defend against:

1. **Prompt injection** -- external content that tries to hijack agent behavior (role overrides, instruction resets, social engineering of agents)
2. **Cascading injection** -- a compromised or manipulated agent injecting instructions into other agents via the channel system
3. **Encoding-based evasion** -- injection hidden in base64, Unicode control characters, zero-width text, RTL overrides, or HTML comments
4. **Credential exfiltration** -- agents or injected content trying to read or leak API keys, passwords, or database contents
5. **Trust level spoofing** -- client-supplied headers attempting to escalate message trust classification
6. **Tool abuse** -- runaway or manipulated agents exhausting resources, deleting files, or making unauthorized network connections
7. **Frontier-model adversaries** -- agents more capable than either of our individual classifiers, crafting injection that fools a single LLM
8. **Helpful agent bypass** -- non-malicious, goal-directed agents that circumvent security controls to efficiently complete authorized tasks. This is a novel threat category: the agent is not attacking the system, it is helping the user by routing around obstacles — and the security system is the obstacle. Darkhan addresses this with architectural constraints (HMAC anchoring, deploy mode, federation gate) that cannot be bypassed regardless of intent.

We do NOT claim to defend against:
- A human attacker with shell access to the host machine and knowledge of the service user password
- Supply chain attacks on our dependencies (npm packages, Ollama, Node.js itself) — though we mitigate this with `npm audit` in CI, pre-commit hooks, and dependency auditing (see [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md))
- Side-channel attacks on the local LLM (adversarial token sequences purpose-built for the specific Ollama model in use)
- A compromised cloud LLM provider returning manipulated classification results from both providers simultaneously
- Social engineering of the human admin (if the admin is tricked into running malicious commands, Darkhan cannot intervene)

### Scan Pipeline

Every message flows through a security pipeline before reaching agents or storage:

```
Message arrives
    │
    ├─ Human internal message (scanHumanMessages: false)
    │     → regex pattern scan → allow/flag
    │
    ├─ Human internal message (scanHumanMessages: true)
    │     → full pipeline below (defends against session hijacking)
    │
    └─ External / Agent / Federated message:
         │
         ├─ 1. Content normalization
         │     Strip Unicode control chars, zero-width chars, RTL overrides,
         │     HTML comments. Decode and scan base64 blocks.
         │
         ├─ 2. Regex pattern scan
         │     30+ injection patterns checked against normalized text
         │     AND decoded base64 content. Critical match → block.
         │
         ├─ 3. Two-LLM consensus classification
         │     Local Ollama AND cloud Gemini/Anthropic/OpenAI both classify the
         │     message independently. Both must agree SAFE.
         │     Disagreement → quarantine for human review.
         │
         └─ 4. Action
              allow (both classifiers + patterns agree safe)
              flag (single classifier available, marked safe)
              quarantine (classifier disagreement — human must review)
              block (critical pattern match or both classifiers agree threat)
```

Agent-to-agent messages get the full pipeline, not just external ones. This closes the cascading injection vector where a compromised agent poisons other agents through channel messages.

All scanning flows through a single `sanitizeMessage()` entry point. There are no parallel or duplicate scan paths — every message hits the same pipeline with the same decision logic.

### Defense Layers

**Input/Output Scanning**
- Regex + local LLM classification on all incoming messages
- Content normalization strips encoding tricks before scanning (Unicode control chars, zero-width text, RTL overrides, HTML comments, base64 decode-and-scan)
- Two-LLM consensus for external and agent-origin messages (local Ollama + cloud provider must agree — cross-company independence supported)
- Action-Evidence Protocol: 15-verb controlled vocabulary with system-captured evidence, automatic claim downgrade, cross-provider verification
- Observation-Evidence Protocol: signal-interpretation separation with mandatory alternative interpretations and confidence scoring
- Automatic privilege boundary detection: system flags when agents access sensitive resources outside authorized scope
- Tool output injection scanning on `fs.read()` and `shell.exec()` before results reach the LLM context
- Outbound leak prevention scans for API keys, passwords, private keys

**Agent Containment**
- Per-agent file write permissions (agents can only write to designated directories)
- Shell command restrictions with two modes: blocklist (default) blocks known-dangerous commands; allowlist mode (Mythos-hardened) only permits explicitly listed commands
- Tool invocation rate limits (200 reads, 50 writes, 10 shell execs per task)
- Network egress deny-default policy (only Ollama, Gemini API, Anthropic API allowed)
- Environment variable whitelist for both worker shell processes and interactive terminal PTY sessions (secrets never exposed)
- Process isolation via `fork()` with IPC-only communication
- Worker onboarding data minimization (no hostname, platform, port, or other agents' LLM details)

**Trust Verification**
- Evidence-based reporting with SHA-256 hashes binding claims to their verification method and result
- Ground truth registry with automatic contradiction detection
- Claim verifier tags every agent message before storage
- LLM model file integrity verification at startup
- Model version tagging on every LLM call (model + digest in activity trail)
- Message trust levels: `human_verified`, `agent_local`, `agent_federated`, `external`, `quarantined` — determined server-side from authentication method; client headers cannot influence trust assignment
- Ed25519 instance identity with cryptographic message signing

**Anomaly Detection**
- Behavioral baseline per agent: rolling 24-hour averages of messages, LLM calls, shell execs, file writes, active channels, active hours
- 3x deviation triggers anomaly alert
- Baselines update daily at 0200 ET; require 3+ days of data before considered reliable

**Integrity Hardening**
- Cryptographic baseline anchoring (HMAC-SHA256) — baseline file tamper detection backed by database anchor
- First-boot vs baseline-deleted detection — deleting the baseline file triggers lockdown, not re-trust
- Deploy mode (`node server.js --deploy`) — human-authenticated baseline reset with lockdown PIN
- Ed25519 private key isolation — signing keys in `secrets.db`, inaccessible to workers
- Federation gate — all federation traffic blocked by default unless `FEDERATION_APPROVED_PEERS` is explicitly set
- Node birth certificates — provenance data recorded at provisioning time for federation trust decisions
- Agent security constraints injected at onboarding — architectural limits on what agents can modify

**Audit and Recovery**
- Complete activity logging: every user message, Claude response, tool call, LLM request, file read/write, shell command, and permission decision logged to the immutable hash chain
- Immutable hash chain with CRISPR defense spacers marking security events
- File integrity monitoring (SHA-256 baseline, verified every 5 minutes)
- Automatic lockdown on impersonation, repeated injection, data leaks, or integrity violations
- Human-only unlock with PIN (agents architecturally cannot lift lockdown)
- Break-glass recovery tool requiring interactive TTY + PIN
- Password recovery via admin-generated one-time tokens (no email required)

**Encryption at Rest**
- API keys AES-256-GCM encrypted in secrets.db with HMAC-indexed lookups
- Encryption key derived from SESSION_SECRET via HKDF
- Auto-migration encrypts existing plaintext keys on startup

### 3-Layer Credential Hardening

| Layer | Mechanism |
|-------|-----------|
| 1 | Break-glass recovery requires interactive TTY -- blocks scripted or automated access |
| 2 | `_darkhan` service user owns sensitive files; application code runs under a separate account |
| 3 | macOS Keychain stores secrets outside the filesystem entirely |

### Execution Tiers

Users control how much autonomy agents get through three execution tiers, changeable at any time from Settings:

| Tier | Pre-Approved | Requires Approval |
|------|-------------|-------------------|
| **Supervised** (default) | Read operations | All writes, edits, commands |
| **Operational** | Reads + code edits, file writes, commands | Security-sensitive operations |
| **Autonomous** | Everything except security | Credential access, auth, admin ops |

**The security boundary is architectural, not policy.** Operations touching credentials, authentication, admin actions, or direct database access always require human approval -- even in autonomous mode. Tool calls are classified by both tool name and input content: a `Bash` call that reads a log is a "write," but a `Bash` call that touches `secrets.db` is "security."

Changes take effect on the next Claude session. All tier changes and auto-approvals are logged to the immutable audit trail.

### Lockdown

Security events trigger automatic lockdown. All agent traffic stops. Only a human admin can unlock via the web UI with a PIN. Lockdown state is HMAC-signed -- database tampering causes the system to fail closed (stay locked).

For full details, see [SECURITY.md](SECURITY.md).

---

## Features

**Agents and Workers**
- Define agents as JavaScript modules with scheduled tasks and message listeners
- Workers receive `llm`, `darkhan`, `tools`, `observe`, `evidence`, `config`, `log` interfaces from the runtime
- Cron scheduling, error isolation, timeout enforcement
- Sequential within a worker, parallel across workers
- Onboarding service injects verified identity into every LLM call

**Communication**
- Channel-based messaging (create channels for any purpose)
- Real-time WebSocket updates (Socket.IO)
- Auto-responder with two-tier routing: local LLM triage then cloud escalation
- Telegram bridge (optional) for external stakeholders

**Integrated Terminal**
- Full Claude Code sessions inside the Darkhan web UI via xterm.js + node-pty
- General-purpose shell terminal (bash/zsh) for system commands, SSH, and administration
- Unified Claude session: terminal and chat share the same Claude process and context
- Claude's terminal work is bridged to channels so agents and humans see what's happening
- Split terminal observer: watch the running Claude session in real-time in a side-by-side panel while chatting
- Pop-out window support for multi-monitor setups (drag terminal to second screen)
- Per-user execution tiers (supervised/operational/autonomous) with hard security boundary
- Configurable permission mode with smart routing (terminal prompts if open, chat notifications if not)
- Session persistence with 120-second grace period on page refresh
- All terminal session events and interactions logged to the immutable hash chain audit trail

**LLM Support**
- Native local inference (node-llama-cpp, $0): Qwen 2.5 7B default (runs on any 16GB+ Apple Silicon Mac), 3B for 8GB machines, or any GGUF model via Ollama manifests. Metal GPU acceleration on Apple Silicon.
- Google Gemini: pay-per-use for agent workers
- Anthropic Claude: pay-per-use for strategic tasks
- OpenAI ChatGPT: pay-per-use for agent workers and consensus
- Per-agent rate limits are user-configurable (set `requestsPerDay: 0` for unlimited)
- Two-level rate limiting: per-provider global limits and per-agent limits
- Cost tracking with per-agent breakdowns

**Knowledge Base (Folio)**
- File browser with markdown rendering
- Full-text search across the Folio
- File create, edit, delete via API and web UI
- Per-agent write permissions

**Web UI**
- Vanilla JS SPA, dark theme, no framework dependencies
- Channels, tasks, agent health dashboard, Folio browser, cost reporting
- Integrated Claude Code and shell terminals with pop-out window support
- Admin settings: lockdown control, password management, PIN setup, execution tier control
- PWA with service worker

**Federation**
- Hub + remote worker architecture
- Workers use identical code locally or remotely
- Authenticated via per-agent API keys
- mTLS support for inter-node encryption
- CRISPR defense spacers propagate across federated instances

**Session Continuity**
- Automatic channel transcripts: verbatim conversation capture to `docs/transcripts/` every 30 minutes
- One file per day (`Transcript_YYYY-MM-DD.md`), code blocks stripped, organized by channel
- Smart writes: skips when no new messages (no redundant writes overnight)
- New Claude sessions read today's + yesterday's transcripts for full context on startup
- Session cycling at 50 messages keeps context lean without losing history
- Transcripts live in `docs/` (not `server/`) -- writes never trigger integrity lockdown
- Human users can also add notes to `docs/` for agents and team members to reference

**Operational Hygiene**
- Automatic startup cleanup: PID tracking, orphan process detection, stale heartbeat purging
- Daily maintenance cycle: database VACUUM, expired session cleanup, activity log trimming, dead worker detection
- Admin-triggered maintenance via API (`POST /api/health/maintenance`)
- Pre-commit hook blocks secrets, source maps, database files, private keys, and large files
- CI pipeline: `npm audit`, secret scan, source map blocker, syntax check, smoke test
- Release checklist with continuous evaluation process (see [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md))

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
    await darkhan.post('chan_coordination', 'My Agent online.');
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
        await darkhan.post('chan_coordination', result.response);
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
| Auth | `POST /api/auth/login`, `/logout`, `/change-password`, `/set-lockdown-pin`, `GET/POST /api/auth/execution-tier` |
| Messages | `GET /api/messages`, `POST /api/messages` |
| Tasks | `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id` |
| Health | `GET /api/health/status`, `POST /api/health/ping`, `GET /api/workers`, `POST /api/health/maintenance` (admin), `GET /api/health/maintenance` |
| Terminal | `GET /api/terminal` (active session status) |
| Folio | `GET /api/folio/tree`, `GET /api/folio/file`, `PUT /api/folio/file`, `GET /api/folio/search` |
| Security | `GET /api/security`, `POST /api/security/lockdown`, `POST /api/security/unlock` |
| Activity | `GET /api/activity`, `GET /api/activity/chain-head`, `GET /api/activity/stats` |
| Ground Truth | `GET /api/ground-truth`, `POST /api/ground-truth`, `POST /api/ground-truth/check` |
| Context | `GET /api/context/brief`, `GET /api/context/state`, `GET /api/context/transcript`, `GET/POST /api/context/settings` |
| Costs | `GET /api/costs/daily`, `GET /api/costs/total` |

WebSocket namespaces:
- `/` -- channel messaging, task updates, agent health (`new_message`, `task_update`, `agent_health`, `delete_message`)
- `/terminal` -- Claude Code and shell terminal sessions (`terminal:spawn`, `terminal:output`, `terminal:input`, `terminal:exit`)

---

## Deployment

**Single node (local)** -- one machine runs the server and all workers:
```bash
cd server && node server.js
```

**Single node (VPS)** -- deploy on a $5 virtual server with automatic HTTPS:
```bash
# Behind Caddy reverse proxy (recommended)
DARKHAN_TRUST_PROXY=true DARKHAN_HTTPS=true \
  DARKHAN_ALLOWED_ORIGINS=https://your-domain.com \
  node server.js
```

Darkhan detects external exposure without TLS and warns at startup. Per-IP login rate limiting, WebSocket origin validation, and secure cookie flags activate automatically. See [SECURITY.md](SECURITY.md#vps-deployment-hardening) for the full VPS hardening guide.

**Multi-node (federated)** -- one hub, remote workers on other machines:
1. Hub runs `server.js` (database, web UI, local workers)
2. Remote nodes run `remote-runner.js` (workers post results to hub via HTTP API)
3. Nodes connect over Tailscale or any private network (mTLS available for encryption without VPN)

See [SETUP.md](SETUP.md) for launchd configuration, service user setup, and Keychain provisioning.

---

## Platform Support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon) | Supported -- full feature set including native sandbox |
| macOS (Intel) | Supported |
| Linux VPS | Supported -- all features except macOS-native sandbox (sandbox-exec) |
| Linux Desktop | Supported -- same as VPS, add Ollama for local LLM |
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

Enterprise federation for connecting multiple Darkhan instances across an organization is available as [Mokume](https://mokume.ai) — a separate product with its own 14B intelligence layer for cross-node security monitoring, message routing, and enterprise situational awareness.

---

## Background

The name comes from Mongolian/Turkic: a *darkhan* is a master craftsman whose skill earned them autonomy. The forge is where craftsmen work. Each team member -- human or agent -- is a craftsman with a defined specialty. Darkhan is the forge that coordinates them.

Built by [5R Industries LLC](https://github.com/5RIndustries). Evolved from five iterations of an internal command center (2026), then rebuilt from scratch with security as the foundation.
