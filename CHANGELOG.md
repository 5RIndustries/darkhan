# Changelog

All notable changes to Darkhan are documented here.

## [1.0.0] — 2026-04-03

First public release. Darkhan is a self-hosted AI command center that gives you full control over your AI agents — what they can do, what they can see, and what happens when they go wrong.

### Adversarial Testing & Security Hardening (2026-04-03)

Three-pass adversarial test validated the full security pipeline before public release.

- **Two-LLM consensus for human messages** — New `scanHumanMessages` config option routes human-origin messages through the full scan pipeline (content normalization + regex + two-LLM consensus). Defends against session hijacking and compromised browser extensions. Disabled by default; enabled with `"security": { "scanHumanMessages": true }` in config.
- **Parallel consensus execution** — Local and cloud LLM classification calls now run via `Promise.all`, reducing consensus latency by ~40%.
- **Consensus token budget fix** — Increased `maxTokens` from 10 to 256 for consensus classification calls. Thinking models (Gemini 2.5 Flash) require headroom for internal reasoning before producing the SAFE/SUSPICIOUS/MALICIOUS verdict.
- **fullScan() origin check fix** — Two-LLM consensus was only triggered for external/federated/agent origins. Internal-origin messages now also get consensus when `scanHumanMessages` is enabled.
- **Flag action handling** — Consensus `flag` action (single-model threat or degraded mode) was silently treated as `allow`. Now surfaces as `{ safe: false, action: 'flag' }` and is blocked at the message route.
- **Lockdown loop resilience** — Three fixes to prevent the unlock → verify → re-lock cycle: (1) 10-minute grace period after admin baseline reset, (2) baseline file auto-recovery from in-memory state if deleted at runtime, (3) startup recovery when baseline file is missing but admin reset occurred within 15 minutes.
- **Baseline file protection** — Integrity baseline path added to shell denylist and security input patterns. Agents cannot delete or reference the baseline file via shell commands.
- **Dev mode sentinel** — Development mode switched from `DARKHAN_DEV_MODE` environment variable to `.dev` sentinel file (gitignored). Cannot accidentally ship to production.
- **Test results** — Pass 2 (regex-only): 30/32 semantic injection payloads bypassed. Pass 3 (full pipeline): 32/32 blocked or quarantined. See [Adversarial Testing Report](docs/ADVERSARIAL-TESTING-REPORT.md).

### Channel Transcripts (2026-04-02)
Automatic verbatim conversation capture for session continuity. Every Darkhan instance maintains a rolling transcript of channel conversations.

- **Auto-capture to `docs/transcripts/`** — Server captures all messages from `#command`, `#claude`, and `#alerts` to daily markdown files (`Transcript_YYYY-MM-DD.md`). Code blocks are stripped; everything else is verbatim.
- **Smart 30-minute interval** — Writes every 30 minutes, but only when new messages exist since the last write. No redundant writes overnight or during idle periods.
- **24-hour daily blocks** — One file per day. At midnight the date rolls and a new file starts. Clean separation for search and reference.
- **Session continuity** — New Claude sessions (after cycling at 50 messages, server restarts, or fresh starts) are instructed to read today's and yesterday's transcripts as their first action. Combined with 100 recent channel messages in the system prompt, this gives fresh instances full conversational context.
- **Outside integrity scope** — Transcripts write to `docs/` which is not monitored by the integrity system. Agents and humans can all write to `docs/` without triggering lockdown.
- **Agent onboarding awareness** — The onboarding service now includes transcript location and format in every agent's startup brief. Workers know where to find historical context.
- **Human-accessible** — The `docs/` directory is a shared space. Human users can add daily notes, meeting records, or other documents alongside transcripts for everyone to reference.

### Session Cycling (2026-04-02)
Automatic session management to prevent context bloat and maintain consistent performance.

- **50-message cycling threshold** — After 50 messages, the Claude session is closed and a fresh one is created. The hash-chain activity log preserves full history.
- **Continuity on fresh sessions** — New sessions receive: 100 recent channel messages, system events from the activity log, transcript file paths, and instructions to read CLAUDE.md and session logs.
- **Progress indicator** — During tool-heavy turns, the "thinking" message updates live with tool count, elapsed time, and current tool name (`...working (3 tools, 12s) — Bash`).
- **Stale busy flag recovery** — If the busy flag gets stuck for >5.5 minutes, it auto-clears instead of blocking all subsequent messages.
- **15-second resume timeout** — If resuming a stored session takes >15s (dead session on API side), falls through to create fresh instead of hanging.
- **Local LLM escalation fix** — When local LLM escalates to Claude after a session cycle, it now routes through the unified session (auto-creates) instead of prompting for a terminal.

### Execution Tiers (2026-04-02)
Per-user control over agent autonomy. Users choose how much freedom agents have when using tools, with an architectural security boundary that cannot be bypassed at any tier.

- **Three tiers: supervised, operational, autonomous** — Supervised (default) requires approval for all writes. Operational pre-approves code edits, file writes, and commands. Autonomous pre-approves everything except security-sensitive operations.
- **Architectural security boundary** — Tool calls are classified by both tool name and input content inspection. Operations touching credentials, passwords, API keys, databases, admin actions, or destructive git operations are classified as "security" and always require human approval, regardless of tier. This is enforced in the `canUseTool` callback and cannot be overridden by configuration or agent behavior.
- **Input-aware classification** — A `Bash` call reading a log file is classified as "write" (auto-approved in operational tier). A `Bash` call referencing `secrets.db` is classified as "security" (always prompted). Classification uses regex pattern matching on tool inputs, not just tool names.
- **Per-user database setting** — Stored in the `users` table (`execution_tier` column). Changeable via Settings UI or `POST /api/auth/execution-tier`. Human users only -- agents cannot change their own tier.
- **Full audit trail** — Tier changes logged as `execution_tier_changed`. Auto-approved calls logged as `tier_auto_approved`. Security boundary prompts logged as `security_boundary_prompt`. All entries go to the immutable hash chain.
- **Session-scoped** — Tier is read when a Claude session is created. The active tier is announced in the system prompt so the agent understands its operating constraints. Changes take effect on the next session.

### Integrity Hardening Framework (2026-04-02)
Comprehensive security hardening driven by adversarial analysis of the integrity baseline system. During a fresh install on a clean node, an AI agent bypassed the integrity system by deleting the baseline file to resolve a lockdown — choosing efficiency over security. Subsequent adversarial analysis revealed architectural gaps. This framework closes those gaps through **architectural constraints** — defenses that make bypass physically impossible, not just inadvisable.

- **First-boot vs baseline-deleted detection** — The integrity service now distinguishes between a genuine first boot (no database) and a deleted baseline (database with users exists). A missing baseline with an existing database triggers immediate lockdown and CRITICAL alert. Previously, deleting the baseline file caused the system to treat a restart as first boot and trust everything.
- **Cryptographic baseline anchoring (HMAC-SHA256)** — The integrity baseline is now anchored with an HMAC-SHA256 signature stored in the database `settings` table. The anchor key is domain-separated from `SESSION_SECRET`. On startup, the baseline file is verified against the stored anchor. A mismatch (baseline file tampered externally) triggers immediate lockdown. An agent that forges both the baseline file and the target files still cannot forge the database anchor without `SESSION_SECRET`.
- **Ed25519 private key isolation** — The instance identity private key has been moved from `darkhan.db` (accessible to workers) to `secrets.db` (server-only). Existing installs auto-migrate on first startup: the key is copied to `secrets.db` and deleted from the main database. A compromised agent reading `darkhan.db` can no longer extract the signing key.
- **Deploy mode (`node server.js --deploy`)** — Human-authenticated baseline reset. Requires an interactive TTY (not Claude Code or scripts), verifies the lockdown PIN via bcrypt, then resets the integrity baseline. Provides a legitimate alternative to baseline deletion for deploying code changes in production. Three failed PIN attempts exit the process.
- **Baseline verification logging** — Every successful baseline verification now logs a `baseline_verified` entry to the activity trail, creating a positive audit record (not just alerts on failure).
- **Node birth certificate** — The seed process now records provenance data (`node_created_at`, `node_created_by`, `node_created_method`, `node_hostname`) in the `instance_identity` table. This enables federation trust decisions based on how a node was provisioned — an agent-provisioned node can be treated with degraded trust compared to a human-provisioned node.
- **Interim federation gate** — All federation traffic is now blocked by default unless `FEDERATION_APPROVED_PEERS` is set in the environment. This is a comma-separated list of approved peer hostnames. With no approved peers configured, all outbound federation requests are rejected. This prevents an agent from establishing unauthorized federation connections.
- **Agent security constraints in onboarding** — The worker onboarding brief now includes explicit architectural constraints: agents must NEVER delete/modify the integrity baseline, establish federation trust, modify core service files, or read secrets. If a security control blocks a task, agents must post to #alerts and wait for a human admin.
- **Dev mode production warning** — If `DARKHAN_DEV_MODE` is active with users in the database, the integrity service logs a WARNING at startup. This catches the case where dev mode (which disables all integrity checks) is accidentally left enabled in production.
- **Lockdown PIN minimum increased to 8 characters** — The minimum lockdown PIN length has been increased from 4 to 8 characters, both server-side and client-side.
- **Dev mode removed from production launchd plist** — `DARKHAN_DEV_MODE=true` was found active in the production launchd configuration, silently disabling all integrity checks. Removed and plist reloaded.
- **Plaintext API key removed from launchd plist** — A plaintext `GOOGLE_API_KEY` was found in the production launchd configuration. Removed; API keys should only exist in `.env` or macOS Keychain.

#### "Helpful Agent" Threat Model
This hardening introduces a novel threat category: the **non-malicious, goal-directed agent** that bypasses security to efficiently complete authorized tasks. Unlike traditional threat models focused on malicious actors, this addresses the case where an AI agent — acting in good faith to help the user — circumvents security controls because they are obstacles to task completion. The integrity hardening framework treats agent goal-directedness as a security-relevant property requiring architectural (not behavioral) constraints.

### VPS Deployment Hardening (2026-04-02)
Safety net for deploying Darkhan on virtual private servers exposed to the public internet.
- **Trust proxy support** — `DARKHAN_TRUST_PROXY` env var configures Express `trust proxy` for correct IP resolution behind reverse proxies (Caddy, nginx, Cloudflare).
- **WebSocket origin validation** — Socket.IO connections now validate the `Origin` header against `DARKHAN_ALLOWED_ORIGINS`. Connections from unlisted origins are rejected with a security warning.
- **Per-IP login rate limiting** — 5 failed login attempts per IP address per 15 minutes, across all usernames. Prevents credential stuffing attacks that rotate usernames against a single IP.
- **Secure cookie flags** — When `DARKHAN_HTTPS=true` or TLS is configured, session cookies are set with `secure: true` and `sameSite: strict`. HTTP deployments use `sameSite: lax`.
- **Startup safety warning** — Server detects when binding to `0.0.0.0` without TLS and prints a prominent warning with instructions for Caddy, Tailscale, or explicit acknowledgment via `DARKHAN_ALLOW_EXTERNAL=true`.

### Fresh Install Schema Fix (2026-04-02)
- **OEP/AEP tables added to schema.sql** — The `observation_records` (Observation-Evidence Protocol) and `evidence_traces` (Action-Evidence Protocol) tables were created at runtime by their respective services but were missing from `db/schema.sql`. On fresh installs, other services would query these tables before the async `CREATE TABLE IF NOT EXISTS` completed, causing a crash (`SQLITE_ERROR: no such table`). Both tables and their indexes are now part of the seed schema.

### Documentation: No-Homebrew Install + LAN Deploy (2026-04-02)
- **Manual prerequisite install** — SETUP.md now documents installing Node.js and Ollama without Homebrew (direct tarball + curl script), for machines without sudo access.
- **LAN-based rsync install** — New section for deploying Darkhan to same-network machines via rsync instead of git clone, with notes on native module rebuild requirements.
- **New troubleshooting entries** — Covers native module failures after rsync, integrity lockdown on first boot, and PATH issues with non-Homebrew installs.

### Split View Navigation Fix (2026-04-02)
- **Left panel routing** — In split mode (chat left, terminal right), clicking sidebar nav items now correctly switches the left panel instead of creating a third pane. `showView()` routes lazy-created views to `split-left-panel` when in split mode.

### Status Dot Fix (2026-04-02)
- **Correct last-seen tracking** — Agent status dots now track the most recent message timestamp per user instead of the oldest, fixing a bug where status showed red despite active chatting.

### Terminal Session Queuing (2026-04-02)
- **Wait instead of drop** — Terminal messages sent while the unified Claude session is busy now queue with a 5-minute timeout instead of being silently dropped. Users see a "[Session is processing another request — waiting...]" message.

### Google Workspace Tools for Workers (2026-04-02)
- **`tools.google.drive.list()`** — List files in Google Drive folders.
- **`tools.google.drive.upload()`** — Upload files to Google Drive.
- **`tools.google.drive.createDoc()`** — Create Google Docs from content.
- **`tools.google.docs.get()`** — Read Google Doc content.
- **`tools.google.docs.update()`** — Update Google Doc content.
- All operations use `@googleworkspace/cli` with whitelisted environment, 30s timeout (60s for uploads), rate-limited, and logged to the activity trail.

### Complete Activity Logging (2026-04-02)
Closed the gap between the conversation record (messages table) and the immutable audit trail (hash chain). Every interaction is now SHA-256 hash-chained.
- **Unified session logging** — User messages (chat and terminal), Claude's assistant responses, every tool call, turn completion with duration/tool count, errors, and permission decisions all logged to the activity hash chain.
- **Worker agent logging** — LLM calls (provider, model, tokens, duration), file reads/writes (path, size), shell commands (command, exit code, output length), and message posts (channel, message ID) all logged.
- **One clean record** — Between the messages table (conversation content) and the activity log (every action), there is now a complete, tamper-evident record of everything that happens in Darkhan across all interfaces.

### Split Terminal Observer (2026-04-02)
Live view of the unified Claude session in the split panel — see tool calls, code output, and thinking in real-time while chatting.
- **Real xterm.js terminal in split panel** — Replaces the old placeholder. Auto-connects to the unified session as a second subscriber.
- **Bidirectional input** — Type in either the chat or the split terminal. Both go to the same Claude instance, same shared context.
- **Independent session key** — Split terminal uses `_claude_observer` key, doesn't interfere with the main terminal.
- **Clean lifecycle** — Auto-cleanup when closing split mode or switching views. Separate Socket.IO connection.
- **Scroll fix** — Views properly restored when exiting split mode (views moved back to main container, scroll position reset).

### Smart Permission Routing (2026-04-02)
Configurable permission mode with intelligent routing between terminal and chat.
- **`permissionMode` configurable** — Set `terminal.permissionMode` in config (`bypassPermissions`, `acceptEdits`, `default`, `plan`). Defaults to `bypassPermissions` for backward compat.
- **`canUseTool` callback** — SDK permission requests routed through Darkhan's approval system instead of bypassed.
- **Terminal-aware routing** — If a terminal subscriber is active, permission prompts show in the terminal (formatted box with `[y] Allow [n] Deny [a] Always allow`). If no terminal, prompts post to chat one at a time.
- **One at a time** — SDK pauses the stream on each permission. Next permission only appears after you approve/deny the current one.
- **Approval from either interface** — Terminal: type `y/n/a`. Chat: reply `approve/deny/always`.

### Terminal Output Formatting (2026-04-02)
- Line spacing between different event types (text → tool calls, tool calls → text) for readability.
- Spinner cleanup preserves whitespace instead of collapsing it.

### Observation-Evidence Protocol (2026-04-02)
New trust layer extending AEP from actions to observations. AEP answers "did the agent do what it said it did?" OEP answers "did the agent see what it said it saw?"
- **`server/services/observation-evidence.js`** — 18 structured observation types across system, behavioral, and communication categories (PROCESS_IDLE, LOG_SILENCE, TIMING_ANOMALY, QUALITY_DECLINE, THINKING_MODE, etc.).
- **Signal-interpretation separation** — Every observation requires raw signal data (verifiable by the human) stored separately from the agent's interpretation. Humans can independently verify the signal and assess whether the conclusion is correct.
- **Mandatory alternative interpretation** — Every observation must include a "could be wrong" field. Observations without an alternative explanation are rejected by the system.
- **Confidence from signal independence** — Confidence computed from the number of independent supporting signals: 1 signal = low, 2 = medium, 3+ = high. Agents cannot make high-confidence claims from a single signal.
- **Worker runtime integration** — Agents access OEP via `context.observe.record()`, with system helpers for common checks (process idle, process absent, resource pressure).
- **Human verification tracking** — Humans can mark observations as verified and select the alternative interpretation if the primary was wrong. Accuracy stats tracked per observation type.

### Automatic Privilege Boundary Detection (2026-04-02)
System-level enforcement of the Ethical Capability Architecture principle that capability does not constitute authorization.
- **Sensitive file access detection** — Worker runtime automatically detects when agents read files in sensitive paths (.env, secrets.db, .ssh, credentials) and records a PRIVILEGE_BOUNDARY evidence entry in the immutable audit trail.
- **Sensitive shell command detection** — Shell commands touching sensitive resources (printenv, .env, secrets.db, /etc/passwd) trigger automatic PRIVILEGE_BOUNDARY recording.
- **System enforcement, not agent self-reporting** — The agent cannot suppress or modify privilege boundary evidence. The system catches it independently.

### Cross-Provider Claim Verification Consensus (2026-04-02)
Extension of two-LLM consensus from injection detection to claim verification.
- **`crossProviderVerify()`** — Submits agent message AND system-captured evidence trail to two independent LLMs from different providers. Each model independently evaluates whether the agent's claims match the evidence.
- **Conservative on disagreement** — When models disagree on verification level, the system uses the more conservative (lower trust) verdict.
- **Automatic on every agent message** — Runs in `_postToChannel` whenever an agent message contains detectable claims. Results stored in message metadata.

### Unified Claude Session v3 (2026-04-01)
Complete rewrite of the Claude integration layer. Claude Code now runs as a persistent SDK session shared between the terminal and chat interfaces.
- **Per-turn streaming** — SDK v2's `session.stream()` is per-turn (yields events for one `send()`, then completes). Session stays alive for subsequent turns. Previous architecture assumed a persistent stream, causing session death after each message.
- **No heavy preamble** — System prompt gives Claude identity, folio path, and operating rules. Claude reads files when it needs them, not upfront. Eliminates 30-60s cold-start delays.
- **Session persistence** — Session IDs saved to disk (`~/.claude/darkhan-unified-sessions.json`). On server restart, sessions resume via `unstable_v2_resumeSession` instead of creating a fresh session. Context is preserved.
- **Concurrency guard** — `busy` flag prevents concurrent send/stream calls. Chat waits if terminal is processing, and vice versa.
- **Dead session recovery** — Detects EPIPE/closed errors and automatically recreates the session (resume first, fresh fallback).
- **5-minute stream timeout** — Prevents hung sessions from blocking indefinitely.
- **Terminal privacy** — Terminal input/output stays in the terminal. Chat input/output stays in the chat channel. Both use the same Claude brain (shared context).
- **Terminal spinner** — Tool calls collapse into a single animated spinner line (`⠹ Thinking... (Read, Bash, Glob)`) instead of 20+ lines of tool output. Clears when the response arrives.
- **120-second grace period** — Terminal socket disconnect grace period extended from 30s to 120s. Prevents session death during long Claude responses.

### Review Gate (2026-04-01)
Optional output verification layer. When enabled, Claude's responses are reviewed by the local LLM before posting.
- **Off by default** — Users opt in via `/review-gate on` in chat.
- **Local LLM review** — Uses the 14B model ($0 per review, ~3-5s overhead). Checks for unverified claims, hallucinations, contradictions, and overconfident statements.
- **Visible flags** — Issues are appended to the response as warnings, not silently blocked. Users see exactly what was flagged.
- **Severity levels** — `critical` (default) only flags unverified claims and hallucinations. `all` flags everything.
- **Config** — `darkhan.config.json` → `reviewGate: { enabled, model, severity }`.
- **Inspired by** OpenAI's Codex plugin review gate pattern, adapted for Darkhan's architecture.

### Slash Commands (2026-04-01)
Built-in commands handled by Darkhan instantly (no LLM call, no debounce):
- **`/status`** — Shows worker status (running/idle/disabled), Claude session state, review gate state. One command, full operational picture.
- **`/review-gate on|off|status`** — Toggle the output review gate.
- **`/help`** — Lists all available commands.

### Pushover Removed (2026-04-01)
- Pushover escalation system removed. Legacy from a predecessor system when the lead agent ran in a separate terminal.
- Replaced with in-UI prompt: when Claude has no active session, Darkhan tells the user to open the Terminal tab.
- `getClaudeStatus()` presence checker (ACTIVE/REST) removed — no longer needed.
- Pushover config keys removed from `darkhan.config.json`, `.env.example`, and `darkhan.config.example.json`.

### Chat↔Terminal Architecture (2026-04-01)
- **Chat is public** — Messages in channels are visible to all agents and humans. Claude's responses to chat messages are posted back to the channel.
- **Terminal is private** — Direct workspace between the user and Claude. Not bridged to channels.
- **Shared brain** — Both interfaces use the same Claude SDK session. Context from terminal conversations is available when the user asks questions in chat, and vice versa.
- **Auto-routing** — When a unified session is active, ALL human messages route to Claude (even routine ones that would normally go to the local LLM). When no session exists, the local LLM handles routine messages and prompts the user to open a terminal for complex requests.

### Client-Side Fixes (2026-04-01)
- **Socket listener guard removed** — `new_message` event handler was gated on `currentView === 'chat'`, causing chat to stop updating when viewing the terminal. Messages now always update the feed regardless of active view.
- **Split-panel real-time updates** — Split-panel chat view now receives real-time message updates via Socket.IO.
- **Socket reconnect handling** — Auto-rejoins channels on reconnect; reloads messages to catch anything missed during disconnect.
- **Terminal re-fit on layout change** — xterm.js recalculates column width when entering/exiting split mode.
- **CSS min-height fix** — Added `min-height: 0` to `.view` flexbox containers, preventing the message input from being pushed off-screen when message history is long.

### Dead Code Removal (2026-04-01)
- **Deleted `server/services/claude-api.js`** — Deprecated since 3/27, legacy Anthropic API integration.
- **Deleted `server/routes/claude.js`** — Deprecated route, only consumer of claude-api.js. Route mount removed from server.js.
- **`DARKHAN_RELAY_MODE`** — Relay mode environment variable standardized. Reads legacy env var for backward compatibility.

### Action-Evidence Protocol (2026-04-01)
- **`server/services/action-evidence.js`** — Core trust layer. 13-verb controlled action vocabulary (WROTE_CODE, DEPLOYED, VERIFIED, SEARCHED, CLAIMED, etc.) with required evidence schemas. Evidence is captured automatically by the system from tool execution — agents do not self-report. Automatic downgrade when evidence doesn't match claims. Persistent traces in SQLite. Every message is evaluated against its evidence trail and tagged: verified, partial, claimed, or contradicted.
- **Worker runtime integration** — Every tool call (fs.read, fs.write, shell.exec, web.search, web.fetch) now records structured evidence with content hashes. Each task starts a trace; each message is evaluated before DB insertion.

### OpenAI/GPT Provider Support (2026-04-01)
- **Fourth LLM provider** — OpenAI Chat Completions API added to `llm.js`. Supports gpt-4o, gpt-4.1 family, gpt-4.1-mini, gpt-4.1-nano, o3-mini. Full rate limiting, cost tracking, and error handling.
- **Cross-provider consensus** — Two-LLM consensus can now use models from different companies (e.g., local Qwen + OpenAI GPT). Genuinely independent verification with different training data and architectural biases.
- **Setup wizard** — OPENAI_API_KEY prompt added. Config example updated with OpenAI provider and rate limits.

### Web Research Tools for Workers (2026-04-01)
- **`tools.web.search()`** — Google Custom Search API integration. Workers can search the web directly. Falls back gracefully when API not configured.
- **`tools.web.fetch()`** — Fetch any URL with timeout and size limits. Content passes through ASI01 injection scanning before reaching LLM context. All web tool usage logged to activity trail.

### Default LLM Upgraded to 14B (2026-04-01)
- **Qwen 2.5 14B** is now the default local model (was 3B). Requires 16GB+ RAM. Setup wizard still offers 3B fallback for smaller systems.
- **Minimum capability check** — Server warns at startup if local model is below 14B. Triage, injection detection, and consensus participation are unreliable below this threshold.

### Model-Agnostic Architecture (2026-04-01)
- **User chooses all models** — Any Ollama-compatible model works for any role. Four cloud providers (Ollama, Google, Anthropic, OpenAI) are built in. Darkhan enforces a capability floor (14B recommended), not a brand.
- **Zero cloud dependency possible** — A fully air-gapped setup with only open-source models is supported.

### Incident Response Framework (2026-04-01)
- **`INCIDENT-RESPONSE.md`** — Full incident response plan: detect, contain, analyze, fix, communicate, return. Includes post-mortem template, user-facing guidance, and communication timeline commitments (24h initial disclosure, 72h full post-mortem).
- **`server/scripts/incident-snapshot.js`** — One-command forensic capture tool. Snapshots databases (via SQLite backup for WAL consistency), config (secrets redacted), integrity baseline, 7-day audit log export (CSV), hash-chain summary, process list, network connections, file permissions, git state, and system info. Outputs a SHA-256-hashed tarball. Run this FIRST when you suspect a compromise.

### Supply Chain Hardening — Dependency Reduction (2026-04-01)
Removed 3 single-maintainer npm packages and replaced with Node.js built-ins:
- **`uuid` → `crypto.randomUUID()`** — 13 files updated. Node built-in since v19.
- **`glob` → removed** — was imported but never used (dead code).
- **`dotenv` → `process.loadEnvFile()`** — 3 files updated. Node built-in since v20.6.
- Direct dependencies reduced from 17 → 14. Single-maintainer risk packages reduced from 4 → 1 (helmet only).
- Motivation: Axios npm supply chain attack (2026-03-31) showed nation-state actors targeting single-maintainer packages.

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

### Red Team Audit Fixes (2026-03-31)
Eight findings from red team security audit, all resolved:
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
- **Knowledge base** — browse, search, and edit markdown files from the Folio

### Security (Grade A- — independently audited by red team + adversarial self-audit, updated 2026-04-02)
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
- **File integrity monitoring** — SHA-256 baseline with HMAC-SHA256 anchoring, first-boot vs baseline-deleted detection, deploy mode for human-authenticated resets
- **Integrity hardening** — cryptographic baseline anchoring, Ed25519 private key isolation to secrets.db, federation gate (blocked by default), node birth certificates, agent security constraints, "helpful agent" threat model
- **Brute-force protection** — exponential backoff on failed login attempts + per-IP rate limiting across all usernames
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
- Node.js 20.12+
- 16GB+ RAM (for 14B local model)
- Ollama (for local LLM — Qwen 2.5 14B default, 3B fallback for smaller systems)
- Optional: Claude Code CLI (Max plan recommended), Google/Anthropic/OpenAI API keys

### License
BSL 1.1 — free for non-production use, converts to Apache 2.0 after 3 years.
