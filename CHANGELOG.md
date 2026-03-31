# Changelog

All notable changes to Darkhan are documented here.

## [1.0.0] — 2026-04-03 (planned)

First public release. Darkhan is a self-hosted AI command center that gives you full control over your AI agents — what they can do, what they can see, and what happens when they go wrong.

### P0 Security Hardening (2026-03-31)
Driven by cross-referencing the Anthropic Claude Code source map leak against Darkhan's attack surface. Five fixes addressing trust spoofing, credential exposure, file permissions, scan pipeline integrity, and onboarding data minimization.

1. **Trust level now server-side only (H3)** — Removed `x-darkhan-origin` client header from trust level determination. Origin is now derived exclusively from the server-side authentication method: session = internal, API key with `agent_` prefix = agent, federation header = federated. A malicious client can no longer spoof trust levels.
2. **Shell PTY environment filtered (H1)** — Interactive shell terminal sessions now receive only whitelisted environment variables: `HOME`, `PATH`, `LANG`, `USER`, `TERM`, `SHELL`, `TMPDIR`. Claude Code mode additionally gets `ANTHROPIC_API_KEY`. `SESSION_SECRET`, `GOOGLE_API_KEY`, and all other secrets are no longer exposed to terminal sessions.
3. **Relay session file permissions (M2)** — `~/.claude/darkhan-relay-sessions.json` is now written with mode 600 (owner-only). Permissions are applied via `chmod` after atomic rename to prevent race conditions.
4. **Single security scan pipeline (H4)** — Removed a duplicate standalone `scanForInjection()` + `classifyWithLocalLLM()` code path that ran independently of the main `sanitizeMessage()` pipeline. All scanning now flows through a single pipeline. Quarantine decisions come exclusively from `fullScan()` consensus. No more divergent security decisions between two independent scan paths.
5. **Worker onboarding data minimization (M3)** — Stripped from worker onboarding briefs: hostname, platform, process uptime, port, and other agents' LLM providers/models. Workers now receive only their identity, their LLM config, their permissions, their channels, and other agent names (no infrastructure details). A compromised worker no longer gets a deployment map.

### Dependency & Supply Chain Hardening (2026-03-31)
Driven by internal audit after the Anthropic Claude Code source map leak. See [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) for the full analysis.
- **11 npm vulnerabilities → 0** — all transitive dependency chains audited and fixed
- **Replaced `connect-sqlite3`** with custom `session-store.js` — eliminated 7 vulnerabilities from the `tar` → `node-gyp` → `cacache` → `http-proxy-agent` chain
- **Upgraded `sqlite3` to 6.x** and **`bcrypt` to 6.x** — eliminated `tar` path traversal chains via `node-gyp` and `@mapbox/node-pre-gyp`
- **Fixed `path-to-regexp` ReDoS** and **`brace-expansion` hang** — via `npm audit fix`
- **Added `npm audit --audit-level=high`** to CI pipeline — fails build on HIGH+ vulnerabilities
- **Added source map blocker** to CI — prevents Anthropic-class leaks
- **Created `.npmignore`** — defensive filter even though we don't publish to npm
- **Fixed `.gitignore` gap** — `server/*.db` pattern was missing (only `server/db/*.db` was covered)
- **Created pre-commit hook** (`scripts/pre-commit-hook.sh`) — blocks source maps, database files, environment files, private keys, hardcoded secrets, large files, and live worker configs
- **Created release checklist** (`RELEASE-CHECKLIST.md`) — continuous evaluation process with daily, weekly, per-release, and quarterly audit cadences

### Operational Hygiene (2026-03-31)
- **Maintenance service** (`server/services/maintenance.js`) — automatic startup cleanup and daily hygiene:
  - PID file tracking for orphan process detection after crashes
  - Stale heartbeat purging (agents not seen in 24h marked as `down`)
  - Expired session cleanup (sessions older than 7 days)
  - Activity log trimming (entries older than 30 days)
  - Database VACUUM (disk space reclamation)
  - Dead worker detection and reporting
  - Temp file cleanup (`/tmp/darkhan-sandbox/`)
- **Admin maintenance API** — `POST /api/health/maintenance` (trigger on demand), `GET /api/health/maintenance` (last run status)
- **Clean shutdown** — maintenance service removes PID file on graceful exit; crash leaves PID file for next startup to detect

### Core Platform
- **Federated worker architecture** — define agents in config, run them as isolated workers with sandboxed permissions
- **Channel-based communication** — team channels with real-time WebSocket updates
- **Web UI** — dark-themed command center with chat, dashboard, task board, worker status, cost tracking, docs browser
- **Integrated terminal** — Claude Code and shell terminals directly in the web UI with shared context
- **Split-screen and pop-out views** — multi-monitor support, any view in its own window
- **Knowledge base** — browse, search, and edit markdown files from the vault

### Security (Grade B+ — independently audited by Corey Red Team, updated 2026-03-31)
- **Credential isolation** — secrets.db separated from main database, 600 permissions, never exposed to workers
- **API key encryption at rest** — AES-256-GCM with HMAC-indexed lookups
- **Identity enforcement** — agents cannot impersonate humans or each other
- **Hash-chain audit log** — immutable, tamper-evident activity trail
- **Injection scanning** — pattern-based + LLM cloud escalation for ambiguous messages
- **Two-LLM consensus** — external and agent messages classified by both local and cloud models
- **Content normalization** — strips Unicode tricks, zero-width chars, RTL overrides, base64 encoding
- **Shell allowlist** — only explicitly permitted commands in hardened mode
- **Agent-to-agent scanning** — all inter-agent messages get full security pipeline
- **Behavioral baselines** — per-agent anomaly detection on message and LLM usage patterns
- **File integrity monitoring** — SHA-256 baseline with tamper detection and auto-lockdown
- **Brute-force protection** — exponential backoff on failed login attempts
- **Lockdown system** — fail-closed, PIN-protected, human-only unlock
- **Pre-commit secret scanner** — blocks credential commits before they happen
- **Password recovery** — admin-generated one-time tokens, no email required

### Federation Foundation
- **Multi-node workers** — run agents across machines, coordinated via HTTP API
- **Ed25519 instance identity** — cryptographic signing for message authenticity
- **Trust levels** — messages tagged by origin (human, agent_local, agent_federated, external, quarantined)
- **Quarantine queue** — human review of consensus-disagreement messages
- **Security event SSE stream** — real-time event feed for federation hub integration
- **mTLS support** — mutual TLS for inter-node communication

### Operations
- **Cost tracking** — per-agent, per-provider token and cost accounting
- **Rate limiting** — configurable per-agent limits with persistence across restarts
- **Scheduled tasks** — cron-based task scheduling with timezone support
- **Nightly security pipeline** — blind spot sweep, audit, and morning brief
- **Break-glass recovery** — TTY-authenticated emergency password reset
- **Auto-start** — launchd integration for macOS

### Developer Experience
- **SETUP.md** — 30-minute zero-to-running guide
- **WORKER-CONTRACT.md** — complete worker API reference
- **SECURITY.md** — threat model, attack vectors, and defense mapping
- **Penetration test guide** — structured pentest plan for external testers
- **Example workers** — ready-to-customize worker templates
- **CI pipeline** — GitHub Actions with lint, secret scan, and smoke test

### Requirements
- macOS (Apple Silicon recommended) or Linux
- Node.js 20+
- Ollama (for local LLM — runs Qwen 2.5 3B on 8GB machines)
- Optional: Claude Code CLI, Google/Anthropic API keys

### License
BSL 1.1 — free for non-production use, converts to Apache 2.0 after 3 years.
