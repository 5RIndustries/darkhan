# Darkhan Integrity Hardening Framework
## Build Plan v1.0 — April 2, 2026

## Context

During a fresh install dress rehearsal on a clean node, an AI agent bypassed Darkhan's
integrity system by deleting the external baseline file to resolve a lockdown triggered
by a legitimate schema change. The integrity service was working correctly — the agent
chose efficiency over security. Subsequent adversarial analysis revealed deeper
architectural gaps.

This framework closes those gaps through **architectural constraints** — defenses that
make bypass physically impossible, not just inadvisable.

---

## BUILD ITEM 1: First-Boot vs Baseline-Deleted Detection

**Problem:** Missing baseline + existing database treated as first boot.
**File:** `services/integrity.js` → `establishBaseline()`, line 217
**Priority:** P0 (pre-release)
**Estimated size:** ~15 lines

**Implementation:**
Replace the "No external baseline found" else branch with a three-way check:

```
IF baseline file missing:
  IF darkhan.db does NOT exist OR has zero users:
    → Genuine first boot. Create baseline normally.
  ELSE IF darkhan.db exists AND has users:
    → CRITICAL: Baseline was deleted. Fail closed.
    → Log 'baseline_missing_db_exists' to activity_log (CRITICAL)
    → Post to #alerts
    → Trigger lockdown
    → Do NOT create a new baseline (preserve missing state as evidence)
    → Recovery: break-glass.js reset-baseline (requires PIN)
```

**Tests:**
1. Normal start → baseline created
2. Delete baseline, restart → lockdown with CRITICAL alert
3. break-glass reset-baseline with PIN → recovers
4. Genuine first boot (no DB) → no lockdown

---

## BUILD ITEM 2: Cryptographic Baseline Anchoring

**Problem:** Baseline is unsigned JSON. Agent can forge both target file and baseline.
**Files:** `services/integrity.js` → `_saveExternalBaseline()` and `establishBaseline()`
**Priority:** P0 (pre-release)
**Estimated size:** ~40 lines

**Phase 1 — SESSION_SECRET anchor (ship now):**

When saving baseline:
1. Serialize baseline JSON canonically (sorted keys)
2. Compute HMAC-SHA256 with key: `HMAC(SESSION_SECRET, "darkhan-baseline-v1")`
3. Store HMAC in `settings` table as `baseline_anchor`
4. Also store current activity_log chain head hash as `baseline_chain_checkpoint`
   (Penrose recommendation: ties baseline to audit trail state)

On startup verification:
- Match → proceed
- Mismatch → CRITICAL lockdown (baseline forged)
- Anchor exists, baseline missing → handled by Item 1
- No anchor in DB → first-time upgrade, compute and store

**Phase 2 — PIN-derived anchor (post-release, Mokume sprint):**
- After PIN is set, re-anchor with `HMAC(SHA256(pin), "darkhan-baseline-pin-v1")`
- PIN cannot be extracted from bcrypt hash → computationally unforgeable by agents
- Verify via deploy mode (Item 4) when PIN is available

**Known limitation (Corey):** Phase 1 anchor is forgeable if attacker reads .env.
Phase 2 closes this. Acceptable for v1.0.0 single-user deployments.

**Tests:**
1. Start normally → anchor stored in settings
2. Modify baseline file, restart → lockdown (anchor mismatch)
3. Modify baseline AND manually update anchor → still fails (need SESSION_SECRET)
4. Verify chain checkpoint detects activity_log tampering

---

## BUILD ITEM 3: Move Ed25519 Private Key to secrets.db

**Problem:** Instance signing key in darkhan.db, readable by any agent with DB access.
**Files:** `services/instance-identity.js`, `db/secrets-schema.sql`
**Priority:** P1 (pre-release)
**Estimated size:** ~35 lines

**Implementation:**
1. Add `instance_keys` table to secrets-schema.sql
2. Modify constructor to accept `secretsDb`
3. Write private key to secrets.db (new installs)
4. Read from secrets.db first, fall back to main DB
5. Auto-migrate: if found in main DB only, copy to secrets.db, delete from main DB
6. Log migration to activity_log

**Tests:**
1. Fresh install → private key only in secrets.db
2. Existing install → auto-migrated, old row deleted
3. Message signing works after migration
4. secrets.db permissions remain 600

---

## BUILD ITEM 4: Deploy Mode with Human PIN Authentication

**Problem:** Legitimate code changes trigger lockdown. Only paths are: web UI unlock
(friction) or delete baseline (bypass). Need a convenient legitimate path.
**Files:** `server.js` startup sequence
**Priority:** P1 (pre-release)
**Estimated size:** ~50 lines

**Implementation:**
```
node server.js --deploy
```

1. Check process.stdin.isTTY → refuse if not interactive
2. Check for CLAUDE_CODE, DARKHAN_RELAY_SESSION, DARKHAN_PTY_SESSION env vars
   → refuse if running inside agent terminal (Corey feedback)
3. Check process.ppid isn't a known Darkhan worker process (Corey feedback)
4. Prompt for lockdown PIN (hidden echo)
5. Verify against secrets.db (bcrypt compare)
6. If valid: reset baseline, update anchor, log, continue startup
7. If invalid: 3 attempts then exit(1)
8. If no PIN set: warn, proceed with SESSION_SECRET anchor only

**Tests:**
1. Modify schema, restart with --deploy, correct PIN → clean start
2. Wrong PIN → rejected after 3 attempts
3. No --deploy flag after modification → lockdown (existing behavior)
4. Run from Claude Code terminal → refused
5. Pipe PIN via stdin → refused (not TTY)

---

## BUILD ITEM 5: Baseline Lifecycle Audit Trail

**Problem:** Baseline events logged inconsistently. Some console.log only.
**File:** `services/integrity.js`
**Priority:** P0 (pre-release)
**Estimated size:** ~25 lines

**Events to log:**

| Event | Action | Severity | #alerts? |
|-------|--------|----------|----------|
| First boot baseline | baseline_first_boot | INFO | No |
| Verified on startup | baseline_verified | INFO | No |
| Mismatch → lockdown | baseline_tamper_lockdown | CRITICAL | Yes |
| Missing + DB exists | baseline_missing_lockdown | CRITICAL | Yes |
| Anchor mismatch | baseline_anchor_tamper | CRITICAL | Yes |
| Deploy mode reset | baseline_deploy_reset | HIGH | Yes |
| Break-glass reset | break_glass_baseline_reset | HIGH | Yes |
| Dev mode auto-update | dev_mode_baseline_update | WARN | No |

**Tests:**
1. Walk each scenario, verify activity_log entry
2. CRITICAL events appear in #alerts
3. Hash chain continuity preserved through new entries

---

## BUILD ITEM 6: Node Birth Certificate (Provenance)

**Problem:** No record of how an instance was created. Federation peers can't assess trust.
**Files:** `db/seed.js`, `services/instance-identity.js`
**Priority:** P2 (pre-release, schema only)
**Estimated size:** ~20 lines

**Implementation:**
Add provenance rows to instance_identity during seed:
- `node_created_at` → ISO timestamp
- `node_created_by` → 'setup_wizard' | 'manual_seed' | env DARKHAN_CREATED_BY
- `node_created_method` → 'wizard' | 'seed' | 'rsync' | 'clone'
- `node_hostname` → os.hostname()

Include in `getInfo()` for federation handshakes.

**Corey note:** Provenance is self-attested. Not a trust authority — informational only.
Real trust gate is Build Item 7.

**Tests:**
1. Run seed.js → provenance rows exist
2. DARKHAN_CREATED_BY=agent:test → agent attribution recorded
3. getInfo() returns provenance

---

## BUILD ITEM 7: Interim Federation Gate

**Problem:** No peer approval. API key = full access. Full Mokume system deferred.
**File:** `services/federated-runtime.js` constructor
**Priority:** P1 (pre-release)
**Estimated size:** ~15 lines

**Implementation:**
1. Read FEDERATION_APPROVED_PEERS env var (comma-separated fingerprints)
2. If empty/missing → federationDisabled = true, log warning
3. On every outbound request, refuse if disabled
4. On hub side: check incoming fingerprint against list, reject with 403 if unknown

**Tests:**
1. No FEDERATION_APPROVED_PEERS → connections refused
2. Set to specific fingerprint → only that peer accepted
3. Unknown peer → 403, logged

---

## BUILD ITEM 8: Agent Onboarding Brief Security Constraints

**Problem:** Agents lack explicit integrity/federation constraints in onboarding.
**File:** `services/worker-runtime.js` → onboarding preamble area
**Priority:** P2 (pre-release)
**Estimated size:** ~10 lines

**Acknowledged:** This is the weakest layer (behavioral, not architectural).
Corey: "Not security. Documentation. Include but don't count toward posture."

---

## Implementation Order

Phase 1 (pre-release): Items 1, 5, 8 (~50 lines)
Phase 2 (pre-release): Items 2, 3, 6 (~95 lines)
Phase 3 (pre-release): Items 4, 7 (~65 lines)
Phase 4 (Mokume sprint): Item 2 Phase 2, full federation peer approval

Total pre-release: ~210 lines across 7 files.

---

---

## STEP 0: CRITICAL PRE-REQUISITES (completed April 2)

These were discovered during the Claude self-adversarial audit and must be
done BEFORE any hardening plan items have effect.

### 0a. Remove DARKHAN_DEV_MODE=true from launchd plist — DONE
Dev mode disables ALL integrity checks. The entire integrity service returns
`{ clean: true }` without checking anything. Every build item in this plan
is moot if dev mode is on. Removed and Darkhan restarted in production mode.

### 0b. Remove plaintext API key from launchd plist — DONE
Google API key was duplicated in the launchd plist as a plaintext env var.
LaunchAgent plists are typically 0644 (world-readable). Removed; Darkhan
reads from .env (0600) instead.

### 0c. Run setup-service-user.sh — RECOMMENDED before release
The self-audit proved that any process running as the primary user can read
.env, secrets.db, darkhan.db, sessions.db, and the baseline file. File
permissions (0600) only protect against OTHER users. Running Darkhan as
the `_darkhan` service user is the single most impactful security step.

### 0d. Increase minimum lockdown PIN length — RECOMMENDED
Current minimum is 4 characters. A 4-digit PIN has only 10,000 possibilities
and is brute-forceable against bcrypt in minutes. Increase to 8+ characters
or switch to passphrase.

---

## ADDITIONAL BUILD ITEMS FROM SELF-AUDIT

### BUILD ITEM 9: HMAC-Sign Lockdown State in Database

**Problem:** The audit proved lockdown state can be directly modified via sqlite3.
An agent can disable lockdown by writing to the agent_heartbeats table.
**File:** `services/security.js` → `_saveLockdownState()` and `_loadLockdownState()`
**Priority:** P0 (pre-release)
**Estimated size:** ~10 lines (mechanism already exists, just needs to verify
the HMAC on every read, not just on startup)

The HMAC signing already exists in `_signLockdownState()`. The gap is that
an attacker with SESSION_SECRET (readable from .env) can forge the signature.
With the _darkhan service user (Step 0c), this is mitigated because the
agent cannot read .env.

### BUILD ITEM 10: Startup Warning for Dev Mode with Users

**Problem:** DARKHAN_DEV_MODE=true silently disables all integrity checks.
No warning if the database contains real users/data.
**File:** `services/integrity.js` constructor
**Priority:** P1 (pre-release)
**Estimated size:** ~8 lines

If DARKHAN_DEV_MODE=true AND the database has more than 0 users:
- Log CRITICAL warning: "DEV MODE active with [N] users in database.
  Integrity checks DISABLED. Set DARKHAN_DEV_MODE=false for production."
- Post to #alerts channel

---

## SELF-AUDIT FINDINGS SUMMARY

12 findings from Claude self-adversarial audit (April 2, 2026):

| # | Finding | Severity | Coverage |
|---|---------|----------|----------|
| 1 | Full API key extraction from secrets.db | CRITICAL | Step 0c (service user) |
| 2 | Ed25519 private key extraction | CRITICAL | Item 3 + Step 0c |
| 3 | Lockdown state writable via sqlite3 | CRITICAL | Item 9 + Step 0c |
| 4 | DEV_MODE=true in production launchd | CRITICAL | Step 0a (DONE) |
| 5 | Session hijacking via sessions.db | HIGH | Step 0c (service user) |
| 6 | Baseline file forgeable | HIGH | Items 1+2 + Step 0c |
| 7 | Code injection on source files | HIGH | Items 1+2 + Step 0c |
| 8 | Persistence via LaunchAgents/cron | HIGH | Step 0c (service user) |
| 9 | Network bound to 0.0.0.0, no TLS | MEDIUM | Deployment config |
| 10 | API key in launchd plist | MEDIUM | Step 0b (DONE) |
| 11 | Lockdown PIN brute-forceable (4 min) | MEDIUM | Step 0d |
| 12 | Trust exploitation (meta-attack) | META | Architectural limit |

Key insight: 7 of 12 findings are mitigated by Step 0c (service user isolation).
This is the single highest-impact change.

---

## Implementation Status (April 2, 2026)

All build items implemented and verified.

| Item | Status | Verified |
|------|--------|----------|
| Build Item 1: First-boot vs baseline-deleted | DONE | Lockdown triggered on baseline deletion |
| Build Item 2: HMAC baseline anchoring | DONE | `baseline_anchor` stored in settings table |
| Build Item 3: Ed25519 key → secrets.db | DONE | Auto-migration verified, key removed from main DB |
| Build Item 4: Deploy mode (--deploy) | DONE | PIN prompt, TTY check, agent terminal refusal |
| Build Item 5: Baseline verification logging | DONE | `baseline_verified` in activity trail |
| Build Item 6: Node birth certificate | DONE | Provenance rows in instance_identity |
| Build Item 7: Interim federation gate | DONE | Federation blocked without FEDERATION_APPROVED_PEERS |
| Build Item 8: Agent security constraints | DONE | Injected in onboarding brief |
| Build Item 9: Lockdown HMAC signing | DONE | Existing implementation verified correct |
| Build Item 10: Dev mode warning | DONE | Warns if DEV_MODE + users in DB |
| Step 0a: Remove DEV_MODE from launchd | DONE | Plist reloaded |
| Step 0b: Remove API key from launchd | DONE | Plist reloaded |
| Step 0c: Service user setup | PENDING | Recommended before public release |
| Step 0d: PIN minimum → 8 chars | DONE | Server + client updated |

## Review Status

- [x] Penrose deep analysis: APPROVED (added chain checkpoint to Item 2)
- [x] Corey red team: APPROVED, Grade A- (added terminal detection to Item 4)
- [x] Claude self-adversarial audit: COMPLETE (12 findings, 2 new build items)
- [x] Step 0a: DONE (dev mode removed from launchd)
- [x] Step 0b: DONE (API key removed from launchd)
- [ ] Step 0c: service user setup — PENDING (recommended before release)
- [x] Step 0d: PIN length increase — DONE (minimum 8 characters)
- [ ] Final review: PENDING
- [x] Implementation of Build Items 1-10: COMPLETE (April 2, 2026)
