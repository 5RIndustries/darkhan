# Darkhan — Build Backlog

> Maintained by Claude (CTO). Items are prioritized and tracked across sessions.
> Updated: 2026-03-28 2145 ET

---

## Priority 1 — Fix Before Shipping to Tino

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

### Remaining P1 [IN PROGRESS]
- [x] ~~Approval queue UI + workflow~~ — Backend + UI complete (2026-03-28)
- [x] ~~Force password change on first login~~ — Backend + UI complete (2026-03-28)
- [x] ~~Output verification gate~~ — Ground truth registry (15 entries, 43 aliases), contradiction detection (7/7 tests pass), integrated into claim verifier pipeline, admin API endpoints. **COMPLETE (2026-03-29)**
- [x] ~~Hash chain federation foundation~~ — CRISPR spacers, chain anchors, origin tracking, 6 Mokume-ready endpoints. **COMPLETE (2026-03-29)**
- [ ] Gmail for Chief (gws CLI) — **PREPPED**, needs the admin interactive OAuth
- [ ] Secrets.db encryption at rest — **NEW (2026-03-29)**, documented security gap from password reset audit

---

## Priority 2 — Next Sprint (Ship to Tino)

### Security Hardening
- [x] ~~mTLS between nodes~~ — Certificate generator, mutual auth, opt-in via config. **COMPLETE (2026-03-29)**
- [x] ~~Native macOS sandbox~~ — Sandbox profiles, env whitelist, resource watchdog, deny-list FS enforcement, sandbox-exec profiles. **COMPLETE (2026-03-29)**
- [x] ~~Session invalidation on password change~~ — Destroys all other sessions. **COMPLETE (2026-03-29)**

### Product Readiness
- [x] ~~Push to private GitHub~~ — `outlaw4shrt/darkhan`, 14 commits. **COMPLETE (2026-03-29)**
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

### Week of March 29 (this week)
| Day | Primary | Secondary |
|-----|---------|-----------|
| Sun 3/29 | Output verification gate (never-lie core) | Gmail OAuth for Chief |
| Mon 3/30 | mTLS between nodes | Push to private GitHub |
| Tue 3/31 | Native macOS sandbox (start) | CONTRIBUTING.md, SECURITY.md |
| Wed 4/1 | Native macOS sandbox (finish) | Per-user timezone |
| Thu 4/2 | Forge terminology + UI polish | Threat flag capability |

### Week of April 5
| Day | Primary | Secondary |
|-----|---------|-----------|
| Mon 4/5 | Tino onboarding test (private repo) | Session invalidation, cleanup |
| Tue 4/6 | Tino feedback integration | Ed25519 keypair design |
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
| **Fri 4/16** | **STTR red team prep (Corey)** | **Freeze Darkhan for STTR focus** |

### April 17 — STTR Internal Red Team
### April 29 — STTR Submission (estimated, pending reauthorization)

**Note:** This schedule assumes ~4-6 hours/day of build time. STTR work takes priority over Darkhan development starting April 16. The schedule front-loads security (mTLS, sandbox) and Tino onboarding so we have a tested product before STTR crunch.

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
| 2026-03-28 | Chief email monitoring | Your Org + OMC Outlook, token refresh, URGENT triage |
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
