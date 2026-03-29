# Darkhan — Build Backlog

> Maintained by Claude (CTO). Items are prioritized and tracked across sessions.
> Updated: 2026-03-28

---

## Priority 1 — Fix Before Shipping to Tino

### From Corey Audit (2026-03-28) — CRITICAL [FIXED]
- [x] ~~Credentials in both databases~~ — Fixed: secrets.db is sole source, no fallback
- [x] ~~Hardcoded session secret fallback~~ — Fixed: server refuses to start without SESSION_SECRET
- [x] ~~Lockdown PIN in both databases~~ — Fixed: fail-closed, secrets.db only
- [x] ~~Worker shell gets process.env~~ — Fixed: whitelisted to HOME/PATH/LANG/USER/TERM

### From Corey Audit (2026-03-28) — HIGH [OPEN]
- [ ] Default password in seed.js — Generate random password, force change on first login
- [ ] WebSocket session auth is a stub — Parse actual session, validate against store
- [ ] No CSRF protection — Add CSRF token or move web UI to API key auth
- [ ] Message body unsanitized (XSS risk) — Verify client uses textContent, add server-side sanitizer
- [ ] No TLS on federation — Document Tailscale is acceptable; enforce HTTPS for non-Tailscale
- [ ] `fsWrite` empty array = write anywhere — Fix: empty = no permissions

### From Session Testing (2026-03-28) — HIGH [OPEN]
- [ ] Email tools not configured on Node 2 — Outlook MCP + gws need install/re-auth (Node 1 has them)
- [ ] Lockdown persists across restart after file changes — Consider: only auto-re-establish baseline on clean startup with admin flag

---

## Priority 2 — Fix This Sprint

### From Corey Audit — MEDIUM [OPEN]
- [ ] Integrity baseline auto-overwrites on restart — Only update when admin commands it
- [ ] Injection detection is regex-only — Run all external-origin through cloud escalation
- [ ] Activity log immutability is defeatable — Merkle tree or hash chain for Mokume
- [ ] Rate limiter resets on restart — Persist state to DB
- [ ] Shell command check only checks first token — Interpreter commands now blocked, but parser could be smarter
- [ ] No brute-force protection on login — Exponential backoff or lockout after N failures

### Feature Gaps
- [ ] Per-user timezone support — Store timezone in user profile, display in viewer's local time, UTC storage
- [ ] Approval queue UI + workflow — Wire up existing approval_queue table for sensitive actions
- [ ] Chief email integration — Wire Outlook MCP + gws into Chief worker for email monitoring
- [ ] Force password change on first login — New installs should require immediate password change

---

## Priority 3 — Mokume / Enterprise Readiness

### Security Architecture
- [ ] mTLS between nodes — Encrypt and mutually authenticate Node 1 ↔ Node 2 traffic
- [ ] Native macOS sandbox — Process isolation using sandbox-exec, pf firewall, ulimit (no Docker)
- [ ] Ed25519 keypair per instance — For signed federation envelopes
- [ ] Channel-level encryption for cross-instance messages
- [ ] Vault NEVER federated — Only explicit versioned snapshots shared
- [ ] Three-tier permission model: Instance / Federation / Mokume
- [ ] Lockdown quarantine (non-propagating) — One instance lockdown doesn't cascade
- [ ] Compromise recovery protocol — Key revocation, re-registration, forensic log retention

### Scalability
- [ ] Audit log export and long-term retention — External storage, integrity verification
- [ ] Key rotation — Automated with zero-downtime rollover
- [ ] Multi-admin RBAC — Different admin tiers, per-admin audit trail
- [ ] Worker resource quotas — CPU/memory/fd limits beyond rate limiting
- [ ] Cross-platform support — Linux, Windows, mobile (macOS first, then expand)

### Product Features
- [ ] Obsidian-replacement knowledge base — Built-in markdown file system with UI (Phase 6 started, needs expansion)
- [ ] Plugin system for Darkhan + Mokume updates
- [ ] Voice/video calling investigation — Granola-type voice-to-text capabilities
- [ ] Penetration testing framework — Automated red team test suite

---

## Priority 4 — Track for Later

### From Corey Audit — LOW
- [ ] Trigger files accumulate in ../../Triggers/ — Add cleanup mechanism
- [ ] Darkhan worker uses sqlite3 shell for audit — Consider DB query API instead
- [ ] WebSocket join_channel has no authorization — Enforce channel membership at socket level
- [ ] No session invalidation on password change — Destroy existing sessions after password change
- [ ] Output verification gate — Ground truth registry, two-LLM consensus for security decisions

---

## Completed Items Log

| Date | Item | Resolution |
|------|------|-----------|
| 2026-03-28 | Agent zero output | dotenv path fix, runOnLoad queuing |
| 2026-03-28 | State.md context truncation | Section extraction with proportional budgets |
| 2026-03-28 | Chief hallucinating email access | Honest capability reporting in system prompt |
| 2026-03-28 | Flash confabulation | Anti-confabulation rule in onboarding |
| 2026-03-28 | DARYL decommission | Plists removed, Llama 3B+8B deleted (6.9GB freed) |
| 2026-03-28 | Federation deployment | Node 1 workers via FederatedWorkerRuntime |
| 2026-03-28 | Timestamp format bug in polling | SQLite-compatible format (no 'Z' suffix) |
| 2026-03-28 | Schema SQL errors on startup | Trigger semicolon parsing fix |
| 2026-03-28 | Lockdown bypass via API key | Session auth + PIN required |
| 2026-03-28 | Admin auth without permission | Feedback memories, CLAUDE.md guardrails |
| 2026-03-28 | Credential isolation | secrets.db with 600 permissions |
| 2026-03-28 | Agent onboarding | Verified briefs + identity preamble injection |
| 2026-03-28 | Evidence-based reporting | EvidenceService with SHA-256 hashes |
| 2026-03-28 | Claim verification | ClaimVerifierService for agent message tagging |
| 2026-03-28 | Daily Corey audit | 0100 ET, evidence-based, Corey-voiced |
| 2026-03-28 | 4 CRITICAL fixes | Credential strip, session secret, PIN fail-closed, env whitelist |
| 2026-03-28 | Git repo | 3 commits, .gitignore secure |
| 2026-03-28 | Professional documentation | README, SETUP, WORKER-CONTRACT |
| 2026-03-28 | Double-dated filenames | Strip leading date before prepending |
| 2026-03-28 | Admin Settings UI | Password change, PIN, lockdown/unlock |
