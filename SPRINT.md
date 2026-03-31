# Darkhan + Mokume — Master Sprint

> **Updated:** 2026-03-30 (end of day)
> **Maintained by:** Claude (CoS/CTO)

---

## Overview — COMPRESSED TO APRIL

| Stage | Product | Goal | Dates | Status |
|-------|---------|------|-------|--------|
| **1** | Darkhan | Public launch on GitHub | Mar 28 — Apr 3 | 74% complete |
| **2** | Darkhan | External users + hardening | Apr 4 — Apr 8 | Not started |
| **3** | Darkhan | Custom LLM + training pipeline | Apr 7 — Apr 14 | 10% (bones laid) |
| **4** | Mokume | Enterprise federation MVP | Apr 14 — Apr 22 | Design only |
| **5** | Both | Revenue-ready | Apr 23 — Apr 30 | Strategy defined |
| **6** | Darkhan Lite | AI threat scanner for non-technical users | TBD (after Stage 1) | Product design complete |

**Stages 2-3 overlap.** Pentest feedback comes in while we build the custom LLM.
**Stages 3-4 overlap.** Federation bones are laid in Darkhan while Mokume scaffold goes up.
**Revenue-ready by April 30.** First security audit engagement booked, Mokume demo-able, pricing live.

---

# Stage 1: Darkhan Public Launch

**Goal:** Repo public, darkhan.ai live, first external visibility
**Dates:** March 28 — April 3
**Status:** 74% complete (28/38 items)

## Done (28)

### Security (16/16 Corey findings)
- [x] Credential isolation (secrets.db) — 3/28
- [x] Hardcoded session secret removed — 3/28
- [x] Lockdown PIN in secrets.db only — 3/28
- [x] Worker env whitelist — 3/28
- [x] Default password force-change — 3/28
- [x] WebSocket session auth — 3/28
- [x] CSRF protection — 3/28
- [x] XSS sanitization — 3/28
- [x] TLS federation opt-in — 3/28
- [x] fsWrite deny-by-default — 3/28
- [x] Integrity baseline admin-only — 3/28
- [x] Injection LLM escalation — 3/28
- [x] Hash chain audit log — 3/28
- [x] Rate limiter persistence — 3/28
- [x] Shell command parser hardening — 3/28
- [x] Brute-force login protection — 3/28

### OWASP ASI Top 10 (10/10, grade B+)
- [x] Forked process isolation — 3/29
- [x] Network egress restrictions — 3/29
- [x] Tool output injection scanning — 3/29
- [x] Path normalization — 3/29
- [x] Tool invocation rate limiting — 3/29
- [x] Per-agent enable/disable toggle — 3/29
- [x] LLM model hash verification — 3/29
- [x] Pre-commit secret scanner — 3/29
- [x] Telegram bridge — 3/29
- [x] Repo sanitized for open-source — 3/29

### Architecture (3/28-3/29)
- [x] Evidence-based reporting — 3/28
- [x] Claim verifier pipeline — 3/28
- [x] Ground truth registry — 3/29
- [x] Output verification gate (never-lie) — 3/29
- [x] Hash chain + CRISPR spacers — 3/29
- [x] Break-glass recovery (TTY + PIN) — 3/29
- [x] 3-layer security hardening — 3/29
- [x] mTLS for federation — 3/29
- [x] Native macOS sandbox — 3/29
- [x] Approval queue — 3/28
- [x] Agent onboarding — 3/28
- [x] Nightly security pipeline — 3/28

### Terminal + UI (3/30)
- [x] Integrated Claude Code terminal — 3/30
- [x] Unified Claude session (shared context) — 3/30
- [x] Shell terminal (bash/zsh) — 3/30
- [x] Terminal pop-out window — 3/30
- [x] Channel-terminal bridge — 3/30
- [x] Split-screen layout — 3/30
- [x] Universal view pop-out — 3/30

### Docs + Ops (3/29-3/30)
- [x] BSL 1.1 LICENSE — 3/30
- [x] Landing page — 3/30
- [x] README rewrite — 3/30
- [x] Corey audit context update — 3/30
- [x] Classification decision log — 3/30
- [x] Telemetry config skeleton — 3/30
- [x] 3B LLM default — 3/30
- [x] GitHub → 5RIndustries — 3/30
- [x] UI workspace branch — 3/30
- [x] LinkedIn posts #1-2 — 3/28-3/29

## In Progress (4)

| Item | Owner | Status |
|------|-------|--------|
| Terminal QA | Adrian | Testing now — confirmed working |
| LinkedIn post #3 | Claude | Tonight |
| Corey audit recommendations | Claude | Identified |
| 3B triage accuracy validation | Claude | Model installed |

## Blocked (1)

| Item | Blocker | Action |
|------|---------|--------|
| Gmail integration | Interactive OAuth | Adrian runs `gws auth login` |

## Remaining (5)

| Item | Target |
|------|--------|
| Secrets.db encryption at rest | 3/31 |
| Clean install dress rehearsal | 3/31-4/1 |
| Password recovery on login page | 3/31 |
| CI pipeline (GitHub Actions) | 4/1-4/2 |
| Changelog + release notes (v1.0.0) | 4/3 |

## Daily Plan — Full April

### Stage 1: Launch (remaining)
| Day | Date | Focus |
|-----|------|-------|
| 4 | 3/31 | Terminal QA, message trust levels, Ed25519 keypair gen, LinkedIn #3 |
| 5 | 4/1 | Quarantine review UI, security event SSE, dress rehearsal start |
| 6 | 4/2 | CRISPR propagation wiring, behavioral baseline, final Corey audit |
| 7 | **4/3** | **RELEASE: repo public, darkhan.ai live, LinkedIn, HN/Reddit** |

### Mythos Defense Items (added to Stage 1)
- [x] Two-LLM consensus on external/agent messages — 3/30
- [x] Agent-to-agent injection scanning — 3/30
- [x] Content normalization (Unicode, base64, HTML) — 3/30
- [x] Shell allowlist mode + expanded blocklist — 3/30
- [ ] Message trust levels (human_verified/agent_local/agent_federated/external/quarantined)
- [ ] Ed25519 keypair per instance (message signing for federation readiness)
- [ ] Quarantine review UI (human review of consensus-disagreement messages)
- [ ] Security event webhook/SSE (real-time event stream for Mokume hub)
- [ ] CRISPR spacer propagation protocol (push defense patterns to federation peers)
- [ ] Behavioral baseline per agent (anomaly detection on message/LLM patterns)

### Stage 2 + 3: External Users + Custom LLM (parallel)
| Date | Stage 2 (Users) | Stage 3 (LLM) |
|------|----------------|---------------|
| 4/4 | Grant Tino + brother repo access | Model version tagging |
| 4/5 | Monitor first external installs | Triage accuracy benchmark |
| 4/6 | Collect + triage feedback | Start LoRA fine-tune pipeline |
| 4/7 | Bug fix sprint from feedback | Model update channel design |
| 4/8 | Password recovery + 2FA design | Privacy policy draft |
| 4/9 | Onboarding friction fixes | Training data review (9 days collected) |
| 4/10 | Recovery codes implementation | Fine-tune first model candidate |
| 4/11 | — | Test darkhan/triage:v1 candidate |
| 4/12 | Community response agent | Package model for Ollama |
| 4/13 | — | Federated learning design doc |
| 4/14 | Stage 2 retrospective | **Custom LLM shipped** |

### Stage 4: Mokume MVP
| Date | Focus |
|------|-------|
| 4/14 | Mokume repo scaffold (on top of Darkhan) |
| 4/15 | Ed25519 keypairs + signed federation envelopes |
| 4/16 | Channel-level encryption |
| 4/17 | Three-tier permission model |
| 4/18 | SSO integration (WorkOS AuthKit or Keycloak) |
| 4/19 | Directory sync (SCIM) |
| 4/20 | Multi-admin RBAC |
| 4/21 | Lockdown vs Quarantine |
| 4/22 | **Mokume demo-ready. Corey red team.** |

### Stage 5: Revenue-Ready
| Date | Focus |
|------|-------|
| 4/23 | Pricing page on mokume.ai |
| 4/24 | SOC 2 gap analysis + remediation plan |
| 4/25 | Security audit service packaging ($7.5K-15K) |
| 4/26 | First outreach to potential customers |
| 4/27 | Pen test framework (automated red team suite) |
| 4/28 | Cross-platform: Linux support |
| 4/29 | Sales materials, demo video |
| **4/30** | **REVENUE READY. First engagement booked.** |

### Stage 6: Darkhan Lite (TBD — after Darkhan public release)
| Phase | Focus | Est. Time |
|-------|-------|-----------|
| MVP | Web scanner at darkhan.ai/scan — paste text, get safety rating | 2-3 hours |
| Phase 2 | Chrome/Firefox/Safari browser extension | 1-2 weeks |
| Phase 3 | Gmail/Outlook email plugins | 1-2 weeks |
| Phase 4 | Mokume integration for enterprise | Stage 4 dependent |

**Darkhan Lite is NOT a fact-checker.** It detects manipulation techniques, not truth. "We don't tell you what's true. We tell you when something is trying to manipulate you."

Tiers: Free (50 scans/day, local LLM) → Pro $9/mo (unlimited, two-LLM consensus) → Team $5/user/mo → Enterprise (Mokume integration)

---

# Stage 2: First External Users

**Goal:** Tino, brother, and friend pentest. Onboarding feedback loop. Hardening.
**Dates:** April 4 — April 8 (5 days, overlaps Stage 3)
**Status:** Not started
**Prerequisite:** Stage 1 complete + Tino NDA signed (done), friend NDA (pending)

## Items

| Item | Priority | Notes |
|------|----------|-------|
| Tino pentest | High | NDA signed 3/30. PENTEST-GUIDE.md ready. Grant repo access. |
| Brother pentest + UI work | High | Has collaborator access. UI workspace branch ready. |
| Friend onboarding | Medium | Needs NDA first. "Coding genius" — high-value feedback. |
| Adrian dress rehearsal | High | Clean Mac, fresh install, full SETUP.md walkthrough |
| Onboarding friction fixes | High | Whatever breaks during external installs |
| Password recovery flow | Medium | PIN-based recovery on login page |
| Recovery codes | Medium | Generated at setup, one-time use, offline backup |
| TOTP / 2FA | Low | Google Authenticator support — post-initial-feedback |
| Community response agent | Medium | GitHub issue/PR triage worker |
| Bug fix sprint | High | Address all pentest findings |

---

# Stage 3: Custom LLM + Federated Learning Foundation

**Goal:** Purpose-built triage LLM, training data pipeline, Mokume connection points
**Dates:** April 7 — April 14 (overlaps Stage 2, feeds Stage 4)
**Status:** 10% (classification log + telemetry skeleton built)

## Items

### Built in Stage 1 (Darkhan-side bones)
- [x] Classification decision log (triage_log table) — 3/30
- [x] Telemetry config skeleton — 3/30
- [x] 3B LLM default (qwen2.5:3b) — 3/30

### Remaining

| Item | Priority | Notes |
|------|----------|-------|
| Model version tagging | High | Tag every LLM call with model name + hash |
| Model update channel | High | Federation protocol for hub-pushed model updates |
| 3B triage accuracy benchmark | High | Validate against actual message classification workload |
| Training data collection (30 days) | Medium | Let triage_log accumulate real decisions |
| LoRA fine-tune pipeline | Medium | Fine-tune 1.5B on triage_log data |
| Custom model packaging | Medium | Ship as `darkhan/triage:v1` via Ollama |
| Privacy policy + consent flow | High | Required before any telemetry |
| Federated learning design doc | Medium | Architecture for Mokume gradient aggregation |

---

# Stage 4: Mokume Enterprise Federation MVP

**Goal:** Multi-instance federation, enterprise auth, demo-ready
**Dates:** April 14 — April 22 (overlaps Stage 3 tail)
**Status:** Design only

## Architecture

| Component | Description | Dependency |
|-----------|-------------|------------|
| Mokume hub | Central coordination server for multiple Darkhan instances | New codebase on top of Darkhan |
| Federation protocol | Signed envelopes, encrypted channels, cross-instance routing | Ed25519 keypairs |
| Enterprise auth | SSO (SAML/OIDC) for customer orgs | WorkOS or Keycloak |
| Multi-tenant RBAC | Per-org permissions, admin tiers | Three-tier permission model |
| Federated learning | On-device training, gradient aggregation | Stage 3 complete |

## Items

### Federation Security
| Item | Priority | Notes |
|------|----------|-------|
| Ed25519 keypair per instance | P0 | Signed federation envelopes |
| Channel-level encryption | P0 | Cross-instance message encryption |
| Three-tier permission model | P0 | Instance / Federation / Mokume |
| Lockdown vs Quarantine | P1 | Local lockdown, network quarantine |
| Compromise recovery protocol | P1 | Key revocation, re-registration |
| Vault NEVER federated | P0 | Explicit versioned snapshots only |
| Two-LLM consensus | P1 | Security decisions require agreement |
| Multi-admin RBAC | P1 | Different admin tiers, per-admin audit trail |

### Enterprise Features
| Item | Priority | Notes |
|------|----------|-------|
| SSO integration | P0 | WorkOS AuthKit or Keycloak (build vs buy decision) |
| Directory sync (SCIM) | P1 | Auto-provision users from corporate directories |
| FGA (Zanzibar) | P2 | Evaluate Ory Keto vs simple RBAC first |
| Audit log export + SIEM | P1 | Datadog, Sentinel, Splunk connectors |
| EKM / BYOK | P2 | Customer-managed encryption keys |
| Compliance dashboard | P1 | AI governance reporting for insurers/regulators |

### Product Features
| Item | Priority | Notes |
|------|----------|-------|
| Plugin system | P1 | Worker-as-plugin, manifest, marketplace |
| Obsidian-replacement KB | P2 | Built-in markdown knowledge base |
| Voice/video calling | P3 | WebRTC + Whisper transcription |
| Pre-mortem protocol | P2 | Structured failure analysis |
| Pen test framework | P1 | Automated red team suite |

---

# Stage 5: Revenue-Ready Product

**Goal:** First paying customer, security audit service, pricing live
**Dates:** April 23 — April 30 (final week)
**Status:** Strategy defined (Penny revenue analysis complete)

## Revenue Streams

| Stream | Price | Target |
|--------|-------|--------|
| Security audit consulting | $7.5K-$15K/engagement | $300K ARR by Dec 2026 |
| Mokume enterprise license | TBD (per-seat or per-instance) | First 5 customers by June |
| Custom LLM training | Included in Mokume | Differentiator |

## Items

| Item | Priority | Notes |
|------|----------|-------|
| US gov compliance (NIST SP 800-171, CMMC) | High | Required for DoD customers |
| FedRAMP path | Medium | Long process, start paperwork early |
| SOC 2 certification | High | Required for enterprise sales |
| Cross-platform (Linux, Windows) | High | macOS-only limits market |
| Mobile client | Medium | PWA covers basic, native app later |
| AI insurance/compliance positioning | High | $4.8B market by 2034 (Penrose research) |
| Darkhan patent filing | Medium | Hash-chain + CRISPR + ground truth as system |
| Key rotation with zero-downtime | Medium | Enterprise requirement |

---

## Key Decisions Log

| Date | Decision | Made By | Stage |
|------|----------|---------|-------|
| 3/28 | Full Darkhan build approved | Adrian | 1 |
| 3/28 | BSL 1.1 license | Adrian + Penny | 1 |
| 3/29 | Public by Friday April 3 | Adrian | 1 |
| 3/30 | Unified Claude session (moonshot) | Adrian + Claude | 1 |
| 3/30 | 3B LLM default | Adrian + Claude | 1, 3 |
| 3/30 | Federated learning via Mokume (Option 1) | Adrian | 3, 4 |
| 3/30 | WorkOS for Mokume auth (evaluate, not commit) | Claude (CTO) | 4 |
| 3/30 | GitHub → 5RIndustries | Adrian | 1 |
| 3/30 | Brother on UI workspace | Adrian | 1, 2 |

---

## Cross-Stage Dependencies

```
Stage 1 (Darkhan Launch)
  └── Classification decision log ──────────┐
  └── Telemetry config skeleton ────────────┤
  └── 3B LLM default ──────────────────────┤
  └── Hash chain + CRISPR ──────────────────┤
  └── Federation API endpoints ─────────────┤
                                            ▼
Stage 3 (Custom LLM)                  Stage 4 (Mokume)
  └── Training data from triage_log    └── Ed25519 signed envelopes
  └── LoRA fine-tune pipeline          └── SSO/SCIM integration
  └── Model update channel ───────────►└── Federated learning hub
                                       └── Enterprise RBAC
                                            │
                                            ▼
                                      Stage 5 (Revenue)
                                        └── SOC 2 + NIST
                                        └── First customers
                                        └── Cross-platform
```
