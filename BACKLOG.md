# Darkhan — Build Backlog

> Items are prioritized and tracked across sessions.
> Updated: 2026-03-29 ET

---

## Priority 1 — Fix Before First External User

### Corey Audit — CRITICAL [ALL FIXED]
- [x] ~~Credentials in both databases~~ — secrets.db sole source, no fallback
- [x] ~~Hardcoded session secret fallback~~ — server refuses to start without SESSION_SECRET
- [x] ~~Lockdown PIN in both databases~~ — fail-closed, secrets.db only
- [x] ~~Worker shell gets process.env~~ — whitelisted to HOME/PATH/LANG/USER/TERM

### Corey Audit — HIGH [ALL FIXED]
- [x] ~~Default password in seed.js~~ — random generated, force change on first login (building)
- [x] ~~WebSocket session auth stub~~ — real session validation from cookie + store
- [x] ~~No CSRF protection~~ — X-Darkhan-Client header on state-changing requests
- [x] ~~Message body XSS~~ — markdown renderer sanitized
- [x] ~~No TLS on federation~~ — FEDERATION_ALLOW_HTTP required, documented
- [x] ~~fsWrite empty = write anywhere~~ — deny-by-default

### Corey Audit — MEDIUM [ALL FIXED]
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
- [x] ~~Corey OWASP ASI Top 10 audit~~ — Grade: B+. All P0s and critical P1s fixed. **COMPLETE (2026-03-29)**

### Remaining P1 [IN PROGRESS]
- [x] ~~Approval queue UI + workflow~~ — Backend + UI complete (2026-03-28)
- [x] ~~Force password change on first login~~ — Backend + UI complete (2026-03-28)
- [x] ~~Output verification gate~~ — Ground truth registry (15 entries, 43 aliases), contradiction detection (7/7 tests pass), integrated into claim verifier pipeline, admin API endpoints. **COMPLETE (2026-03-29)**
- [x] ~~Hash chain federation foundation~~ — CRISPR spacers, chain anchors, origin tracking, 6 Mokume-ready endpoints. **COMPLETE (2026-03-29)**
- [x] ~~Break-glass recovery tool~~ — Interactive TTY + PIN auth, 4 commands (status, reset-password, lift-lockdown, reset-baseline). **COMPLETE (2026-03-29)**
- [x] ~~3-layer security hardening~~ — TTY enforcement, _darkhan service user, macOS Keychain integration. **COMPLETE (2026-03-29)**
- [ ] Gmail integration (gws CLI) — **PREPPED**, needs interactive OAuth
- [ ] Secrets.db encryption at rest — **NEW (2026-03-29)**, documented security gap from password reset audit

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

## Priority 3 — Mokume / Enterprise Federation

### Must-build before going public
- [ ] Ed25519 keypair per instance — signed federation envelopes
- [ ] Channel-level encryption for cross-instance messages
- [ ] Three-tier permission model (Instance / Federation / Mokume)
- [ ] Lockdown vs Quarantine architecture (local lockdown, network quarantine)
- [ ] Compromise recovery protocol (key revocation, re-registration, forensic retention)
- [ ] Vault NEVER federated — explicit versioned snapshots only
- [ ] Two-LLM consensus for security decisions
- [ ] Multi-admin RBAC — different admin tiers, per-admin audit trail

### Product Features
- [ ] Obsidian-replacement knowledge base — full built-in markdown file system
- [ ] Plugin system — worker-as-plugin, manifest, marketplace, versioning
- [ ] Voice/video calling — WebRTC + Whisper/Deepgram transcription
- [ ] Pre-mortem protocol — structured "assume this failed" exercise
- [ ] Penetration testing framework — automated red team test suite
- [ ] US government classification levels — NIST SP 800-171, CMMC, FedRAMP

### Community & Launch
- [ ] License decision (Apache 2.0 vs BSL, legal review needed)
- [ ] Community response agent — GitHub issue/PR triage worker
- [ ] CI pipeline — syntax check, security scan, evidence service tests
- [ ] Release process — semver, changelog, signed artifacts

---

## Priority 4 — Track for Later
- [ ] Trigger file cleanup mechanism
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
| Thu 4/15 | Integration testing + Corey full audit | License decision |
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
| 2026-03-28 | DARYL decommission | Both nodes, plists removed, 6.9GB freed |
| 2026-03-28 | Federation deployment | Node 1 workers via FederatedWorkerRuntime, verified |
| 2026-03-28 | Timestamp format bug | SQLite-compatible format in polling |
| 2026-03-28 | Schema SQL errors | Trigger semicolon parsing fix |
| 2026-03-28 | Lockdown bypass | Session auth + PIN, three feedback memories |
| 2026-03-28 | Credential isolation | secrets.db, no fallback, 600 permissions |
| 2026-03-28 | Agent onboarding | Verified briefs + identity preamble on every LLM call |
| 2026-03-28 | Evidence-based reporting | EvidenceService with SHA-256 hashes |
| 2026-03-28 | Claim verification | ClaimVerifierService auto-tagging on agent messages |
| 2026-03-28 | Corey daily audit | 0100 ET, unrestricted scope, evidence-based |
| 2026-03-28 | All 16 Corey findings | 4 CRITICAL + 6 HIGH + 6 MEDIUM = 16/16 fixed |
| 2026-03-28 | Chief email monitoring | Outlook integration, token refresh, URGENT triage |
| 2026-03-28 | Nightly security pipeline | Darkhan 2330 → Claude 0000 → Corey 0100 → Brief 0600 |
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
| 2026-03-29 | Corey OWASP ASI Top 10 audit | Grade B+. All P0s and critical P1s fixed |
| 2026-03-29 | Open-source repo sanitization | Generic config, example workers, internal refs removed |
| 2026-03-29 | Azure OAuth credential incident | Hardcoded creds removed, moved to .env, secret revoked, scanner prevents recurrence |
