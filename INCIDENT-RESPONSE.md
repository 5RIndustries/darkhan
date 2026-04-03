# Darkhan — Incident Response Plan

> If you are responding to an active incident, skip to [Immediate Actions](#immediate-actions).

## Philosophy

Darkhan will be compromised at some point. Not might — will. Every line of our code is public. Every attacker gets the blueprints. The question is not whether we get breached. It is whether our response proves or destroys our credibility.

Our core promise is that Darkhan does not lie. An incident response is where that promise gets tested hardest.

---

## Immediate Actions

**Do these IN ORDER. Do not skip steps.**

### Step 1: Snapshot (before touching ANYTHING)

```bash
node server/scripts/incident-snapshot.js
```

This captures databases, config, audit logs, integrity baseline, process list, network state, git state, and file permissions into a single timestamped archive. Copy the archive to a separate machine immediately.

**Do NOT restart services, apply patches, delete logs, or modify config before this step.** Forensic evidence is perishable. One restart can overwrite WAL files, rotate logs, and destroy the timeline you need.

### Step 2: Contain

**If lockdown has not already triggered automatically:**
1. Trigger lockdown manually via the web UI (requires admin PIN)
2. If you cannot access the web UI, kill the server process: `pkill -f "darkhan/server"`

**If this is a federated (Mokume) deployment:**
1. Isolate the compromised node: set `federation.enabled: false` in `darkhan.config.json`
2. Notify peer nodes — they should verify their own integrity baselines
3. Each Mokume node is architecturally independent (different keys, different databases, different secrets). A compromise of one node does NOT automatically compromise others.

**Cut network if needed:**
- Darkhan's egress is deny-default (only Ollama, Gemini API, Anthropic API allowed)
- If you suspect the attacker modified egress rules, disconnect the machine from the network entirely

### Step 3: Assess the blast radius

The hash-chain audit log tells you exactly when tampering started:

1. Find the chain break point — every entry before the break is cryptographically verified clean
2. Identify which messages, actions, and agent operations occurred after the break
3. Check the integrity baseline — was it modified? When?
4. Review behavioral baselines — did any agent deviate from normal patterns before the breach?

**Key question to answer:** Was this a code-level attack (supply chain, dependency compromise), a config-level attack (credential theft, account takeover), or a runtime exploit?

### Step 4: Identify the attack vector

| Vector | How to check |
|--------|-------------|
| **Supply chain (npm dependency)** | `npm audit`, check `package-lock.json` diff against last known-good commit |
| **Credential theft** | Check if admin password, API keys, or lockdown PIN were used from an unknown source. Review session logs in `sessions.db` |
| **Configuration tampering** | Diff `darkhan.config.json` against the git version. Check file permissions and modification times in the snapshot |
| **Runtime exploit** | Review the audit log for unusual tool executions, shell commands, or agent actions. Check if sandbox containment was bypassed |
| **Social engineering** | Review message history for prompt injection attempts or instructions that tricked an agent into taking unauthorized action |

---

## Fix and Verify

1. Develop the patch on an isolated branch
2. Red team the fix specifically — not a general audit, but targeted testing of the vulnerability
3. Generate a new integrity baseline
4. Deploy to your own instance first and verify clean state
5. Run Siege (or equivalent adversarial testing) against the patched system for 48 hours
6. Full red team security audit before declaring resolved

---

## Communication

**Timeline commitment:**
- **Initial disclosure:** Within 24 hours of confirmed breach
- **Full post-mortem:** Within 72 hours. If the investigation is ongoing at the 72-hour mark, we will publish what we know and update as we learn more. Honest partial disclosure beats polished silence.

**Every disclosure MUST include:**

1. **What happened** — Specific and technical. Not "a sophisticated attack" if it was a config mistake.
2. **When it happened** — Exact timeline, backed by hash-chain evidence. "We believe the compromise began at [timestamp] based on the audit chain break point."
3. **What was exposed** — Specifically. Not "some data may have been affected." What data. Which components. What scope.
4. **What we did** — Containment actions and their timeline. When we detected it, when we contained it, what we shut down.
5. **What we're changing** — Not just the patch, but what systemic improvement prevents recurrence.
6. **What we don't know** — If there are unknowns, say so. "We have not yet determined X" is honest. Silence is not.

**Channels:**
- GitHub Security Advisory (primary — reaches all watchers)
- Direct notification to known Mokume federation peers
- Blog post / social media for broader awareness
- security@darkhan.ai for direct reports

**What NOT to do:**
- Do not minimize ("a minor incident")
- Do not use passive voice to obscure responsibility ("mistakes were made")
- Do not delay disclosure to protect reputation
- Do not speculate about attacker identity unless you have evidence
- Do not claim "no data was compromised" unless you can prove it with the audit chain

---

## Post-Mortem Template

```markdown
# Incident Post-Mortem: [Title]

**Date of incident:** YYYY-MM-DD
**Date of detection:** YYYY-MM-DD HH:MM UTC
**Date of containment:** YYYY-MM-DD HH:MM UTC
**Severity:** Critical / High / Medium / Low

## Summary
[2-3 sentences: what happened, what was the impact]

## Timeline
| Time (UTC) | Event |
|------------|-------|
| HH:MM | [First indicator of compromise] |
| HH:MM | [Detection] |
| HH:MM | [Containment action] |
| HH:MM | [Fix deployed] |
| HH:MM | [Verified clean] |

## Root Cause
[What specifically caused the vulnerability and how it was exploited]

## Impact
- **Data exposed:** [specific list]
- **Systems affected:** [specific list]
- **Duration of exposure:** [exact timeframe]
- **Users affected:** [count and scope]

## Response Actions
1. [What we did, in order]

## What We're Changing
1. [Systemic improvements, not just the patch]

## What We Don't Know
1. [Honest unknowns]

## Evidence
- Audit chain break point: [hash]
- Snapshot archive: [SHA-256 hash]
- Integrity baseline status: [clean/modified/missing]
```

---

## For Darkhan Users (if YOUR instance is compromised)

If you believe your Darkhan instance has been compromised:

1. **Run the incident snapshot immediately:** `node server/scripts/incident-snapshot.js`
2. **Copy the archive to a separate machine**
3. **Trigger lockdown** (web UI → Settings → Lockdown, requires your PIN)
4. **If federated:** Disable federation and notify your peers
5. **Check the hash-chain audit log** — the chain break tells you when it started
6. **Report to us:** security@darkhan.ai — include your snapshot SHA-256 hash (not the snapshot itself) so we can coordinate if it's a systemic issue

**What Darkhan's architecture gives you:**
- The hash-chain audit log is your forensic timeline. Entries before the break are verified.
- Agent containment is OS-level. A compromised agent cannot access other agents' credentials.
- The integrity baseline is stored outside Darkhan's directory. If the attacker only compromised the application, the baseline is untouched and tells you exactly what changed.
- Ed25519 instance keys are per-node. Compromising one Mokume node does not give the attacker valid signatures for other nodes.

**What it does NOT protect you from:**
- Full machine compromise (root access bypasses all application-level controls)
- Physical access to the machine
- Compromise of the integrity baseline file itself (if attacker has OS-level access)
- An attacker who is patient enough to operate within normal behavioral baselines

---

## Security Reporting

**Found a vulnerability?** We want to hear about it.

- Email: security@darkhan.ai
- Please include: description, reproduction steps, potential impact
- We will acknowledge within 24 hours
- We will not take legal action against good-faith security researchers
- We will credit you in the advisory (unless you prefer anonymity)

---

*This document is part of Darkhan's commitment to operational honesty. We publish our incident response plan because security through obscurity is not security. If an attacker reads this document, they learn our response process — not our weaknesses. Our defenses are architectural, not procedural.*
