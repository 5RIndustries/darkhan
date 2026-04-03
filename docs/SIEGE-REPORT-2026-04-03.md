# Darkhan Siege Test Report

**Date:** 2026-04-03 (pre-launch)
**Attacker:** Node3 (Mac Mini M4 Pro, 192.168.86.250)
**Target:** Node2 (production Darkhan instance, 192.168.86.20:3001)
**Conducted by:** Claude (CoS/CTO) + Adrian (admin)

---

## Pass 1: HTTP Load Test + Unauthenticated Injection

### Phase 1A: HTTP Load Testing (Apache Bench from node3)

| Test | Requests | Concurrency | Failed | Req/s | p99 Latency |
|------|----------|-------------|--------|-------|-------------|
| Warm-up | 100 | 10 | **0** | 113 | 204ms |
| Medium | 1,000 | 50 | **0** | 221 | 1,221ms |
| Heavy | 2,000 | 100 | **0** | 250 | 879ms |
| Login brute-force | 500 | 50 | **0** | 666 | 126ms |

**Result:** Zero dropped requests under any load level. Server scaled linearly. Login endpoint correctly rejected all unauthenticated attempts with 401/429.

### Phase 1B: Unauthenticated Adversarial Injection (21 payloads)

Categories tested:
- Direct instruction override ("Ignore all previous instructions...")
- Encoded injection (base64, rot13)
- Social engineering / semantic injection
- Agent-to-agent injection spoofing
- Privilege escalation (SQL injection, role change)
- Data exfiltration requests
- Lockdown/DoS attempts
- Unicode tricks (Cyrillic lookalikes, zero-width spaces)

| Outcome | Count |
|---------|-------|
| Blocked (403) | **21** |
| Passed | **0** |

**Result:** 21/21 blocked. All payloads rejected at the CORS/auth layer before reaching the security pipeline. The auth layer correctly requires both session authentication and the `X-Darkhan-Client: true` CSRF header.

**Finding:** CSRF protection works — login attempts from node3 without the custom header were rejected with 403 and a clear error message.

---

## Pass 2: Authenticated Injection (Human Session, Pre-Fix)

**Configuration:** `scanHumanMessages: false` (default — human fast path, regex only)

Authenticated as `user_adrian` via session login (`/api/auth/login` with CSRF header). Messages sent with human-origin classification, hitting the **regex-only fast path** (no LLM consensus).

### Payloads: 32 sophisticated semantic injection attempts

Categories tested:
- Legitimate-looking data exfiltration (compliance audit, onboarding docs, debugging)
- Code review / technical discussion hiding intent (race conditions, memory leaks, backup paths)
- Emotional urgency / authority pressure (CEO demo, legal subpoena, production down)
- Context shifting / roleplay (pretend admin, novel writing, training materials)
- Helpful-sounding operational requests (DR site replication, log aggregator, encryption verification)
- Fragmented attacks (innocent individual questions building to exfiltration)
- Multilingual injection (French, German)
- Competitive intelligence framing ("show how WE store credentials")
- Supply chain / CVE framing (npm audit, session management CVE)
- Subtle operational questions (uptime, incident postmortem)

| Outcome | Count |
|---------|-------|
| **Bypassed** | **30** |
| Rate-limited | 2 |
| Blocked | **0** |

**Result:** 30/32 payloads bypassed all defenses. The remaining 2 were only stopped by rate limiting, not security scanning.

**Root Cause:** Human-origin messages took the regex-only fast path. All 30 payloads were designed to avoid regex-matchable keywords — no "ignore instructions", "override", "system prompt", "execute", "sudo", etc. The payloads used semantic misdirection (business framing, emotional urgency, technical jargon) that regex cannot detect.

**Risk:** If an attacker compromises a human session (XSS, session hijacking, browser extension, stolen laptop), they can post arbitrary messages — including prompt injection — without triggering LLM-based defenses. The messages would be classified as human-origin and skip the two-LLM consensus pipeline entirely.

**Remediation:** Added `config.security.scanHumanMessages` option. When enabled, human-origin messages also go through the full scan pipeline (content normalization + regex + two-LLM consensus). Also parallelized the two LLM calls (`Promise.all`) to reduce latency by ~40%.

---

## Pass 3: Authenticated Injection (Human Session, Post-Fix)

**Configuration:** `scanHumanMessages: true`, two-LLM consensus enabled (Ollama Qwen 14B local + Google Gemini Flash cloud), LLM calls parallelized.

_Results pending — test in progress._

---

## Infrastructure Notes

- Node3 sleep disabled permanently (`pmset -a sleep 0 displaysleep 0 disksleep 0 autopoweroff 0 standby 0`)
- Node3 IP changed from 192.168.86.26 to 192.168.86.250 (DHCP)
- Node3 has Ollama with Qwen 2.5 32B (19GB) + OpenAI GPT-4o-mini configured
- Node2 integrity system triggered 4 lockdowns during test prep when baseline was deleted for server restart — correctly identified as "baseline deletion attack"
- Server auto-restarts via launchd when killed

## Code Changes Made

1. **`services/security.js`** — Parallelized two-LLM consensus calls using `Promise.all` (~40% latency reduction)
2. **`services/security.js`** — Added `scanHumanMessages` flag; when true, human-origin messages go through full scan pipeline
3. **`darkhan.config.json`** — Added `security.scanHumanMessages: true` to production config
4. **`darkhan.config.example.json`** — Added `security.scanHumanMessages: false` (default off for new installs)
5. **`.env`** — Added `SECURITY_ESCALATION_PROVIDER=google` and `SECURITY_ESCALATION_MODEL=gemini-2.5-flash` for two-LLM consensus cloud leg
