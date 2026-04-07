# Darkhan — Build Backlog

> Items are prioritized and tracked across sessions.
> Updated: 2026-03-31 ET

---

## Priority 1 — Fix Before First External User

### Red Team Audit — CRITICAL [ALL FIXED]
- [x] ~~Credentials in both databases~~ — secrets.db sole source, no fallback
- [x] ~~Hardcoded session secret fallback~~ — server refuses to start without SESSION_SECRET
- [x] ~~Lockdown PIN in both databases~~ — fail-closed, secrets.db only
- [x] ~~Worker shell gets process.env~~ — whitelisted to HOME/PATH/LANG/USER/TERM

### Red Team Audit — HIGH [ALL FIXED]
- [x] ~~Default password in seed.js~~ — random generated, force change on first login (building)
- [x] ~~WebSocket session auth stub~~ — real session validation from cookie + store
- [x] ~~No CSRF protection~~ — X-Darkhan-Client header on state-changing requests
- [x] ~~Message body XSS~~ — markdown renderer sanitized
- [x] ~~No TLS on federation~~ — FEDERATION_ALLOW_HTTP required, documented
- [x] ~~fsWrite empty = write anywhere~~ — deny-by-default

### Red Team Audit — MEDIUM [ALL FIXED]
- [x] ~~Integrity baseline auto-overwrites~~ — admin-commanded reset only
- [x] ~~Injection detection regex-only~~ — local LLM cloud escalation for external-origin
- [x] ~~Activity log immutability~~ — SHA-256 Merkle hash chain
- [x] ~~Rate limiter resets on restart~~ — loads today's usage from cost_tracking
- [x] ~~Shell command parser~~ — interpreters + env + sqlite3 + base64 blocked
- [x] ~~Brute-force login~~ — exponential backoff after 5 failures

### OWASP ASI Top 10 Audit [COMPLETE]
- [x] ~~P0-1: Forked worker process isolation~~ — Workers run as isolated child processes via fork(). IPC comms. Config: `sandbox.processIsolation = true`. **COMPLETE (2026-03-29)**
- [x] ~~P0-3: Network egress restrictions~~ — Deny-default sandbox network. Only Ollama, Gemini API, Anthropic API allowed. **COMPLETE (2026-03-29)**
- [x] ~~P1-1: Tool output injection scanning~~ — tools.fs.read() and tools.shell.exec() scan output before LLM context. Critical blocks, lower warns. **COMPLETE (2026-03-29)**
- [x] ~~P1-2: Path normalization~~ — Shell commands resolve symlinks and absolute paths before blocklist. **COMPLETE (2026-03-29)**
- [x] ~~P1-3: Tool invocation rate limiting~~ — Max 200 reads, 50 writes, 10 shell execs per task. **COMPLETE (2026-03-29)**
- [x] ~~P1-8: Per-agent enable/disable toggle~~ — POST /api/workers/:id/disable and /enable. Admin only. **COMPLETE (2026-03-29)**
- [x] ~~LLM model hash verification~~ — SHA-256 digest verification against Ollama manifests at startup. **COMPLETE (2026-03-29)**
- [x] ~~Pre-commit secret scanner~~ — .githooks/pre-commit blocks API keys, tokens, private keys, JWTs, connection strings. **COMPLETE (2026-03-29)**
- [x] ~~Repo sanitized for open-source~~ — Generic example config, example workers, internal references removed. **COMPLETE (2026-03-29)**
- [x] ~~Telegram bridge~~ — Long-polling in, HTTPS out, injection scanning, zero external deps. **COMPLETE (2026-03-29)**
- [x] ~~Red Team OWASP ASI Top 10 audit~~ — Grade: B+. All P0s and critical P1s fixed. **COMPLETE (2026-03-29)**

### Remaining P1 [IN PROGRESS]
- [x] ~~Approval queue UI + workflow~~ — Backend + UI complete (2026-03-28)
- [x] ~~Force password change on first login~~ — Backend + UI complete (2026-03-28)
- [x] ~~Output verification gate~~ — Ground truth registry (15 entries, 43 aliases), contradiction detection (7/7 tests pass), integrated into claim verifier pipeline, admin API endpoints. **COMPLETE (2026-03-29)**
- [x] ~~Hash chain federation foundation~~ — CRISPR spacers, chain anchors, origin tracking, 6 Mokume-ready endpoints. **COMPLETE (2026-03-29)**
- [x] ~~Break-glass recovery tool~~ — Interactive TTY + PIN auth, 4 commands (status, reset-password, lift-lockdown, reset-baseline). **COMPLETE (2026-03-29)**
- [x] ~~3-layer security hardening~~ — TTY enforcement, _darkhan service user, macOS Keychain integration. **COMPLETE (2026-03-29)**
- [x] ~~Integrated Claude Code terminal~~ — xterm.js + node-pty in web UI, Claude Code and shell modes, Socket.IO /terminal namespace, session lifecycle audited to hash chain. **COMPLETE (2026-03-30)**
- [x] ~~Unified Claude session~~ — Single Claude SDK process shared between terminal and chat interfaces. Chat @claude and terminal share context. Responses bridged to #claude channel. **COMPLETE (2026-03-30)**
- [x] ~~Shell terminal~~ — General-purpose bash/zsh terminal in web UI for system commands, SSH, administration. **COMPLETE (2026-03-30)**
- [x] ~~Terminal pop-out window~~ — Standalone terminal window for multi-monitor setups. Auto-starts with selected mode. **COMPLETE (2026-03-30)**
- [x] ~~Channel-terminal bridge~~ — Terminal events posted to channels, Claude terminal gets recent channel context, agents see terminal activity. **COMPLETE (2026-03-30)**
- [x] ~~Red Team audit context update~~ — Red Team system prompt updated with full Darkhan architecture so audits focus on real gaps, not sandbox enforcement. Rate limits treated as user configuration. **COMPLETE (2026-03-30)**
- [x] ~~BSL 1.1 LICENSE~~ — Business Source License with 4-year change to Apache 2.0. **COMPLETE (2026-03-30)**
- [x] ~~Landing page~~ — docs/index.html for darkhan.ai. **COMPLETE (2026-03-30)**
- [ ] Gmail integration (gws CLI) — **PREPPED**, needs interactive OAuth
- [x] ~~Secrets.db encryption at rest~~ — AES-256-GCM with HMAC-indexed lookups, auto-migration. **COMPLETE (2026-03-31)**
- [x] ~~Password recovery on login page~~ — Admin token generation + login recovery form. **COMPLETE (2026-03-31)**
- [x] ~~CI pipeline~~ — GitHub Actions: lint, secret scan, smoke test. **COMPLETE (2026-03-31)**
- [x] ~~Behavioral baseline wiring~~ — Service initialized, daily update, anomaly API. **COMPLETE (2026-03-31)**
- [x] ~~Quarantine queue wiring~~ — Consensus disagreements now quarantine messages. **COMPLETE (2026-03-31)**
- [x] ~~Trust level bug fix~~ — Proper human/agent/federated origin detection. **COMPLETE (2026-03-31)**
- [x] ~~Model version tagging~~ — LLM calls log model digest to activity trail. **COMPLETE (2026-03-31)**
- [x] ~~CHANGELOG.md~~ — v1.0.0 release notes. **COMPLETE (2026-03-31)**

---

## Priority 2 — Next Sprint (Ship to First External User)

### Security Hardening
- [x] ~~mTLS between nodes~~ — Certificate generator, mutual auth, opt-in via config. **COMPLETE (2026-03-29)**
- [x] ~~Native macOS sandbox~~ — Sandbox profiles, env whitelist, resource watchdog, deny-list FS enforcement, sandbox-exec profiles. **COMPLETE (2026-03-29)**
- [x] ~~Session invalidation on password change~~ — Destroys all other sessions. **COMPLETE (2026-03-29)**

### Product Readiness
- [x] ~~Push to private GitHub~~ — 16 commits. **COMPLETE (2026-03-29)**
- [x] ~~CONTRIBUTING.md + SECURITY.md + issue templates~~ — **COMPLETE (2026-03-29)**
- [x] ~~Per-user timezone support~~ — User profile timezone, IANA validation, UI uses preference. **COMPLETE (2026-03-29)**
- [x] ~~Forge terminology~~ — "Darkhan — The Forge" throughout UI, README, manifest. **COMPLETE (2026-03-29)**
- [x] ~~Threat flag capability for all workers~~ — darkhan.flagThreat() + CRISPR spacer. **COMPLETE (2026-03-29)**

---

## Priority 2.5 — Federated Learning Foundation (Darkhan-side)

These items lay the groundwork in Darkhan for federated model training via Mokume.

- [x] ~~Classification decision log~~ — triage_log table. **COMPLETE (2026-03-30)**
- [x] ~~Model version tagging~~ — LLM calls log model digest to activity trail. **COMPLETE (2026-03-31)**
- [x] ~~Telemetry config skeleton~~ — `telemetry` block in darkhan.config.json. **COMPLETE (2026-03-30)**
- [ ] Model update channel — federation protocol support for hub-pushed model updates (Mokume sends, Darkhan pulls)
- [ ] Custom Darkhan triage model — fine-tune 1.5-3B model on classification decision log data using LoRA. Ship as `darkhan/triage:v1` via Ollama.
- [ ] Federated learning pipeline (Mokume) — Flower/TFF integration. Local training on-device, gradient aggregation at hub, privacy-preserving. Enterprise feature.
- [ ] Privacy policy and consent flow — opt-in telemetry consent in first-run setup. Required before any data collection.

---

## Priority 3 — Mokume / Enterprise Federation

### Must-build before going public
- [ ] Ed25519 keypair per instance — signed federation envelopes
- [ ] Channel-level encryption for cross-instance messages
- [ ] Three-tier permission model (Instance / Federation / Mokume)
- [ ] Lockdown vs Quarantine architecture (local lockdown, network quarantine)
- [ ] Compromise recovery protocol (key revocation, re-registration, forensic retention)
- [ ] Folio NEVER federated — explicit versioned snapshots only
- [ ] Two-LLM consensus for security decisions
- [ ] Multi-admin RBAC — different admin tiers, per-admin audit trail
- [ ] **Integrity baseline supply-chain hardening** — Current baseline is trust-on-first-boot: whoever controls files at first startup defines "normal." Attack vector: clone repo → modify code → boot → baseline captures compromised state → join Mokume federation as trusted node. Fixes needed: (1) anchor baseline to signed git commit hash, not just file hashes; (2) Mokume attestation — peers verify code integrity state (commit hash + baseline anchor) on federation join; (3) first-boot admin challenge — require admin auth before baseline is established; (4) baseline file tamper-evidence — signed, not a deletable JSON file. Discovered 2026-04-04 during multi-node deployment.
- [ ] **Admin re-baseline CLI** — Clean way to update config/workers on a running Darkhan instance without triggering lockdown or deleting the baseline. Currently the only path is deleting `~/.darkhan-integrity-baseline.json` and rebooting, which bypasses the entire integrity system.

### Product Features
- [ ] Obsidian-replacement knowledge base — full built-in markdown file system
- [ ] Plugin system — worker-as-plugin, manifest, marketplace, versioning
- [ ] Voice/video calling — WebRTC + Whisper/Deepgram transcription
- [ ] Pre-mortem protocol — structured "assume this failed" exercise
- [ ] Penetration testing framework — automated red team test suite
- [ ] US government classification levels — NIST SP 800-171, CMMC, FedRAMP

### Community & Launch
- [x] ~~License decision~~ — BSL 1.1. **COMPLETE (2026-03-30)**
- [ ] Community response agent — GitHub issue/PR triage worker
- [x] ~~CI pipeline~~ — lint, npm audit, secret scan, source map blocker, smoke test. **COMPLETE (2026-03-31)**
- [ ] Release process — semver, changelog, signed artifacts

---

## Priority 4 — Track for Later
- [x] ~~Trigger file cleanup mechanism~~ — maintenance service handles daily cleanup. **COMPLETE (2026-03-31)**
- [ ] Darkhan worker DB query API (replace sqlite3 shell)
- [ ] WebSocket channel authorization enforcement
- [ ] Audit log export + long-term retention
- [ ] Key rotation with zero-downtime rollover
- [ ] Worker resource quotas (CPU/memory/fd)
- [ ] Cross-platform (Linux, Windows, mobile)

---

## Recommended Execution Schedule

### Week of March 29 -- COMPLETED
All P1 and P2 items shipped on 2026-03-29 (15 features in one session). OWASP ASI Top 10 audit completed with B+ grade; all P0s and critical P1s fixed in the same session. Only remaining P1 items are Gmail OAuth (requires interactive auth) and secrets.db encryption at rest.

### Week of April 5 (P3 start)
| Day | Primary | Secondary |
|-----|---------|-----------|
| Mon 4/5 | External user onboarding test (private repo) | Gmail OAuth for Chief |
| Tue 4/6 | Onboarding feedback integration | Ed25519 keypair design |
| Wed 4/7 | Federation signed envelopes (start) | Channel encryption design |
| Thu 4/8 | Federation signed envelopes (finish) | Three-tier permissions |
| Fri 4/9 | Lockdown vs quarantine implementation | Compromise recovery |

### Week of April 12
| Day | Primary | Secondary |
|-----|---------|-----------|
| Mon 4/12 | Mokume hub architecture | Plugin system design |
| Tue 4/13 | Multi-admin RBAC | Two-LLM consensus |
| Wed 4/14 | Pen test framework | Pre-mortem protocol |
| Thu 4/15 | Integration testing + Red Team full audit | License decision |
| **Fri 4/16** | **Red team review** | **Feature freeze** |

**Note:** P1 + P2 completed ahead of schedule (3/29 vs planned 4/5). P3 (Mokume/enterprise federation) starts week of April 5, front-loading external user onboarding and federation security.

---

## Completed Items Log

| Date | Item | Resolution |
|------|------|-----------|
| 2026-03-28 | Agent zero output | dotenv path fix, runOnLoad queuing |
| 2026-03-28 | State.md context truncation | Section extraction with proportional budgets |
| 2026-03-28 | Chief hallucinating email access | Honest capability reporting, then email configured |
| 2026-03-28 | Flash confabulation | Anti-confabulation rule in onboarding |
| 2026-03-28 | Legacy system decommission | Previous iteration removed, 6.9GB freed |
| 2026-03-28 | Federation deployment | Node 1 workers via FederatedWorkerRuntime, verified |
| 2026-03-28 | Timestamp format bug | SQLite-compatible format in polling |
| 2026-03-28 | Schema SQL errors | Trigger semicolon parsing fix |
| 2026-03-28 | Lockdown bypass | Session auth + PIN, three feedback memories |
| 2026-03-28 | Credential isolation | secrets.db, no fallback, 600 permissions |
| 2026-03-28 | Agent onboarding | Verified briefs + identity preamble on every LLM call |
| 2026-03-28 | Evidence-based reporting | EvidenceService with SHA-256 hashes |
| 2026-03-28 | Claim verification | ClaimVerifierService auto-tagging on agent messages |
| 2026-03-28 | Red Team daily audit | 0100 ET, unrestricted scope, evidence-based |
| 2026-03-28 | All 16 Red Team findings | 4 CRITICAL + 6 HIGH + 6 MEDIUM = 16/16 fixed |
| 2026-03-28 | Chief email monitoring | Outlook integration, token refresh, URGENT triage |
| 2026-03-28 | Nightly security pipeline | Darkhan 2330 → Claude 0000 → Red Team 0100 → Brief 0600 |
| 2026-03-28 | Admin Settings UI | Password, PIN, lockdown, unlock, baseline reset |
| 2026-03-28 | Professional docs | README, SETUP, WORKER-CONTRACT (updated twice) |
| 2026-03-28 | Git repo | 9 commits, secure .gitignore |
| 2026-03-28 | CLAUDE.md v3.0 | Mandatory startup verification, integrity rules |
| 2026-03-28 | LinkedIn post | Agent honesty guardrails (Intel/) |
| 2026-03-28 | Blind spot sweeps | Darkhan 2330 ET + Chief 1000 ET |
| 2026-03-28 | CSRF protection | X-Darkhan-Client header |
| 2026-03-28 | Hash chain audit log | SHA-256 Merkle chain with verify endpoint |
| 2026-03-28 | Injection cloud escalation | Local LLM classification for external-origin |
| 2026-03-28 | Brute-force protection | Exponential backoff on login |
| 2026-03-28 | Integrity baseline hardening | Admin-commanded reset only |
| 2026-03-29 | Hash chain + CRISPR spacers | Origin tracking, defense spacers, chain anchors, 6 federation-ready API endpoints |
| 2026-03-29 | Ground Truth Registry | 15 verified facts seeded, contradiction detection (7/7), integrated into claim verifier |
| 2026-03-29 | Output Verification Gate | Ground truth + claim verifier pipeline = never-lie architecture core |
| 2026-03-29 | Chief daily briefing | 0545 ET consolidated report, wikilinked into daily journal |
| 2026-03-29 | Security audit documented | Secrets.db access paths mapped, encryption needed before release |
| 2026-03-29 | Break-glass recovery tool | Interactive TTY enforcement, PIN auth, status/reset-password/lift-lockdown/reset-baseline |
| 2026-03-29 | 3-layer security hardening | Layer 1 (break-glass TTY), Layer 2 (_darkhan service user), Layer 3 (macOS Keychain) |
| 2026-03-29 | mTLS for federation | CA + per-node certs with SAN, mutual auth, opt-in via config |
| 2026-03-29 | Native macOS sandbox | Env whitelist, FS deny-list, resource watchdog, sandbox-exec SBPL profiles |
| 2026-03-29 | Per-user timezone | IANA timezone per user, validated server-side, UI uses preference |
| 2026-03-29 | Forge branding | "Darkhan -- The Forge" throughout UI, manifest, README, CSS |
| 2026-03-29 | Threat flag capability | darkhan.flagThreat() for all workers, structured alert + CRISPR spacer |
| 2026-03-29 | Session invalidation | Password change destroys all other sessions for the user |
| 2026-03-29 | Private GitHub repo | 16 commits |
| 2026-03-29 | Community docs | SECURITY.md, CONTRIBUTING.md, issue/PR templates, .github/ |
| 2026-03-29 | Professional docs update | README, SETUP, WORKER-CONTRACT, BACKLOG updated for all 15 features |
| 2026-03-29 | P0-1: Forked process isolation | Workers as child processes via fork(), IPC, 5s graceful shutdown |
| 2026-03-29 | P0-3: Network egress restrictions | Deny-default sandbox, Ollama/Gemini/Anthropic only |
| 2026-03-29 | P1-1: Tool output injection scanning | fs.read/shell.exec output scanned before LLM context |
| 2026-03-29 | P1-2: Path normalization | Symlink + absolute path resolution before shell blocklist |
| 2026-03-29 | P1-3: Tool invocation rate limiting | 200/50/10 per task for reads/writes/shell |
| 2026-03-29 | P1-8: Per-agent enable/disable | Admin toggle without full lockdown |
| 2026-03-29 | Pre-commit secret scanner | Blocks API keys, tokens, private keys, JWTs in staged diffs |
| 2026-03-29 | LLM model hash verification | SHA-256 against Ollama manifests at startup |
| 2026-03-29 | Telegram bridge | Long-polling in, HTTPS out, injection scanning, zero deps |
| 2026-03-29 | Red Team OWASP ASI Top 10 audit | Grade B+. All P0s and critical P1s fixed |
| 2026-03-29 | Open-source repo sanitization | Generic config, example workers, internal refs removed |
| 2026-03-29 | Azure OAuth credential incident | Hardcoded creds removed, moved to .env, secret revoked, scanner prevents recurrence |
| 2026-03-30 | Integrated Claude Code terminal | xterm.js + node-pty, Claude Code and shell modes, /terminal namespace |
| 2026-03-30 | Unified Claude session | SDK-based single process shared between terminal and chat |
| 2026-03-30 | Shell terminal | General-purpose bash/zsh in web UI |
| 2026-03-30 | Terminal pop-out window | Standalone window for multi-monitor setups |
| 2026-03-30 | Channel-terminal bridge | Terminal events to channels, channel context to Claude terminal |
| 2026-03-30 | Red Team audit context update | Architecture context in system prompt, rate limits as user config |
| 2026-03-30 | BSL 1.1 LICENSE | 5R Industries LLC, 4-year change to Apache 2.0 |
| 2026-03-30 | Landing page | docs/index.html for darkhan.ai |
| 2026-03-30 | README rewrite | Cold-visitor optimized, architecture diagram, terminal docs |
| 2026-03-30 | UI workspace branch | ui-workspace branch + dev guide for contributor UI work |
| 2026-03-31 | Secrets.db encryption at rest | AES-256-GCM + HMAC-indexed lookups, auto-migration of plaintext keys |
| 2026-03-31 | Password recovery | Admin token generation + login page recovery form, bcrypt-hashed tokens |
| 2026-03-31 | CI pipeline | GitHub Actions: npm audit, lint, secret scan, source map blocker, smoke test |
| 2026-03-31 | Behavioral baseline wiring | Service initialized, daily update at 0200 ET, anomaly API |
| 2026-03-31 | Quarantine queue wiring | Consensus disagreements now quarantine messages for human review |
| 2026-03-31 | Trust level bug fix | Proper human/agent/federated origin detection |
| 2026-03-31 | Model version tagging | LLM calls log model identifier + digest to activity trail |
| 2026-03-31 | CHANGELOG.md | v1.0.0 release notes written |
| 2026-03-31 | CLA.md | Contributor License Agreement with DCO sign-off process |
| 2026-03-31 | TERMS.md | Terms of Service for BSL product |
| 2026-03-31 | PRIVACY.md | Privacy policy — no data collection, all local |
| 2026-03-31 | CODEOWNERS | GitHub code ownership for review routing |
| 2026-03-31 | Dependency audit (11→0 vulns) | sqlite3 6.x, bcrypt 6.x, replaced connect-sqlite3, path-to-regexp, brace-expansion |
| 2026-03-31 | Custom session store | session-store.js replaces connect-sqlite3 (eliminated 7-vuln transitive chain) |
| 2026-03-31 | Pre-commit hook | scripts/pre-commit-hook.sh: blocks .map, .db, .env, .key, secrets, large files, live workers |
| 2026-03-31 | .npmignore | Defensive publish filter (prevents Anthropic-class source map leaks) |
| 2026-03-31 | .gitignore gap fix | Added server/*.db pattern (only server/db/*.db was covered) |
| 2026-03-31 | Source map CI blocker | Added to ci.yml — finds .map files outside node_modules |
| 2026-03-31 | npm audit in CI | Added npm audit --audit-level=high to ci.yml |
| 2026-03-31 | RELEASE-CHECKLIST.md | Continuous evaluation process: daily, weekly, per-release, quarterly audit cadences |
| 2026-03-31 | Maintenance service | Startup cleanup + daily hygiene: PID tracking, orphan detection, DB VACUUM, stale heartbeat purge |
| 2026-03-31 | Maintenance API endpoints | POST /api/health/maintenance (admin trigger), GET /api/health/maintenance (last run) |
| 2026-03-31 | P0 security hardening (5 fixes) | Cross-referenced Claude Code source map leak against Darkhan attack surface: (1) trust level server-side only, (2) shell PTY env filtered, (3) relay session file mode 600, (4) single scan pipeline, (5) onboarding data minimization |
| 2026-03-31 | Setup wizard overhaul (setup.js) | changeme default password, no PIN prompt, auto-timezone, auto-open browser, worker file copy, stale DB cleanup, in-process workers default, clear next-steps instructions |
| 2026-03-31 | First-login gated flow (app.js) | Forced password change overlay + forced PIN setup overlay on changeme login; cannot dismiss; no Settings hunting required |
| 2026-03-31 | install.sh improvements | Per-prerequisite install prompts (skip if present), Homebrew PATH auto-add to .zprofile, PAT guidance on clone failure, pull-latest for existing installs |
| 2026-03-31 | Dress rehearsal bug fixes (5) | (1) duplicate must_change_password column in secrets-schema.sql, (2) index on nonexistent api_key_hmac column, (3) missing glob dependency in package.json, (4) missing entry_type column in schema.sql activity_log, (5) SETUP.md incorrect default password |
| 2026-03-31 | Red Team audit fixes (8) | C-1: federation header spoofing, C-2: Socket.IO HMAC bypass, L-4: quarantine INSERT column name, H-5: activity log trimming removed (broke hash chain), M-6: requireHumanAdmin logic bug, H-1: session store table name injection, L-3: orphan detection ps format, M-4: JSON.parse safety in message listing |
| 2026-03-31 | Siege adversarial agent | examples/adversary.worker.js — persistent red team agent, Gemini Flash, 6 probe categories, daily research sweep + adversarial report, designed for Node 3 |
