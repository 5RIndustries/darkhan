# Changelog

All notable changes to Darkhan are documented here.

## [1.0.0] — 2026-04-03 (planned)

First public release. Darkhan is a self-hosted AI command center that gives you full control over your AI agents — what they can do, what they can see, and what happens when they go wrong.

### Portable Config Export/Import (2026-04-01)
- **`scripts/export-config.js`** — Exports a portable configuration file from an existing Darkhan instance. Strips all secrets (API keys, passwords, Ed25519 keypairs, session secrets). Preserves team structure, channels, LLM provider config, permissions, and rate limits. Supports Ed25519 signing (`--sign`) so the receiving node can verify the config came from a trusted source.
- **`setup.js --from-config`** — Imports a portable config on a new node. Shows the human exactly what the config contains (every member, channel, provider, permission) and requires explicit confirmation before applying. Verifies Ed25519 signature if present. Always generates fresh secrets locally — nothing sensitive transfers between instances.
- **Mokume federation prep** — These features are the foundation for Mokume enterprise provisioning. A Mokume hub can offer a signed config; the new node pulls it, the human approves it, and the install runs locally. The hub never gets shell access to the new node.

### Dress Rehearsal Bug Fixes (2026-03-31)
Five bugs caught during clean-install dress rehearsal on MacBook Air:
1. **Seed script duplicate column** — `must_change_password` column declared twice in `secrets-schema.sql`, causing seed failure on fresh installs
2. **Seed schema index on nonexistent column** — Index referenced `api_key_hmac` column that does not exist in the schema
3. **Missing `glob` dependency** — `glob` package used but not listed in `package.json`; `npm install` did not pull it
4. **Missing `entry_type` column** — `activity_log` table in `schema.sql` was missing the `entry_type` column, breaking activity log inserts
5. **SETUP.md incorrect default password** — Documentation referenced a random hex password; actual default is now `changeme`

### Corey Audit Fixes (2026-03-31)
Eight findings from Corey red team audit, all resolved:
1. **C-1: Federation header spoofing** — Added spacer ingestion validation and server-side trust level enforcement; federated messages cannot spoof trust classification
2. **C-2: Socket.IO auth HMAC bypass** — Socket.IO authentication now properly validates HMAC signatures; bypass path closed
3. **L-4: Quarantine INSERT wrong column name** — Quarantine insert was silently broken due to incorrect column name; fixed and verified
4. **H-5: Activity log trimming removed** — Trimming was breaking the hash chain integrity; removed the trim operation to preserve chain continuity
5. **M-6: requireHumanAdmin logic bug** — AND condition was combining two checks incorrectly; separated into distinct checks
6. **H-1: Session store table name injection** — Added validation to prevent SQL injection via session store table name parameter
7. **L-3: Orphan detection wrong ps format** — Fixed `ps` command format string for correct orphan process detection across macOS versions
8. **M-4: JSON.parse safety in message listing** — Added try/catch around JSON.parse calls in message listing to prevent crashes on malformed data

### Siege Adversarial Agent (2026-03-31)
- **New example worker: `examples/adversary.worker.js`** — Persistent hostile red team agent for continuous security testing
- Uses Gemini Flash for research ($0 for HTTP probes)
- 6 probe categories: injection, auth bypass, privilege escalation, data exfiltration, federation spoofing, resource exhaustion
- Daily research sweep for new attack techniques, daily adversarial report to alerts channel
- Designed for dedicated Node 3 deployment (keeps adversarial traffic off production nodes)

### Setup Wizard Overhaul (2026-03-31)
Complete rewrite of `setup.js` for zero-friction onboarding:
- Default password is now `changeme` (no password prompts during setup)
- No PIN prompt during setup — handled by gated first-login flow in the browser
- Auto-detects system timezone (no manual IANA timezone entry)
- Auto-opens browser after server starts (macOS + Linux)
- Copies and configures example worker file for the chosen agent
- Cleans stale databases from previous failed runs
- Defaults to in-process workers (not forked) for simpler first-run experience
- Clear "what happens next" instructions printed after setup

### First-Login Gated Flow (2026-03-31)
New forced security setup on first login (`client/js/app.js`):
- Logging in with `changeme` triggers a forced password change overlay (cannot be dismissed)
- After password change, a forced lockdown PIN setup overlay appears (cannot be dismissed)
- User cannot access any part of the app until both are complete
- Eliminates the need to find Settings manually — every new user completes security setup automatically

### install.sh Improvements (2026-03-31)
Rewrote the install script for real-world reliability:
- Each prerequisite (Homebrew, Node.js, Ollama) asks before installing — skip if already present
- Homebrew PATH auto-added to `~/.zprofile` (the number one friction point on fresh Macs)
- Clear PAT (Personal Access Token) guidance when `git clone` fails for private repos
- Existing installs pull latest instead of re-cloning

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
