# Darkhan Release & Security Hygiene Checklist

> **Purpose:** Continuous evaluation and improvement process for Darkhan releases.
> **Created:** 2026-03-31 — after internal dependency audit + Anthropic Claude Code source map leak analysis.
> **Maintained by:** Claude (CTO) + whoever is cutting the release.

---

## Lessons Learned (What Drove This Document)

### The Anthropic Claude Code Leak (2026-03-31)
A misconfigured `.npmignore` shipped a 59.8 MB source map file in npm package `@anthropic-ai/claude-code@2.1.88`, exposing ~512K lines of TypeScript source, 44 unreleased feature flags, and an unreleased autonomous daemon mode ("KAIROS"). Root cause: **build pipeline hygiene failure** — no CI gate checking for debug artifacts. This was Anthropic's second leak in five days (the first exposed their unreleased "Mythos" model via a CMS misconfiguration).

### Our Own Audit Findings (Same Day)
- 11 npm vulnerabilities (8 HIGH) — all from transitive dependencies we hadn't audited
- `connect-sqlite3` bundled its own `sqlite3@5.x` with a full `node-gyp` → `tar` vulnerability chain
- Database files tracked in git history (0 bytes, but the pattern was wrong)
- `.gitignore` had a gap: covered `server/db/*.db` but not `server/*.db`
- No pre-commit hook — secret scanner only ran at server startup and in CI
- CI pipeline had no `npm audit` step
- No `.npmignore` existed

### Key Principle
**Security failures are mundane.** The Anthropic leak wasn't sophisticated — it was a missing line in a config file. Our vulnerabilities weren't exotic — they were unaudited transitive dependencies. The process must catch the boring stuff, because the boring stuff is what actually ships.

---

## Pre-Release Checklist (Before Every Public Push)

### 1. Dependency Audit
- [ ] `npm audit` returns **0 vulnerabilities** (or all remaining are documented with mitigations)
- [ ] `package-lock.json` committed with integrity hashes for all packages
- [ ] No new dependencies added without reviewing their dependency tree (`npm ls <package>`)
- [ ] Check npm advisories for any package added in this release cycle

### 2. Secret & Artifact Scan
- [ ] Pre-commit hook installed and passing (`scripts/pre-commit-hook.sh`)
- [ ] Zero `.map` files outside `node_modules/`
- [ ] Zero `.env`, `.key`, `.pem`, `.db` files tracked in git (`git ls-files | grep -E`)
- [ ] `server/.env.example` contains only placeholder values
- [ ] `darkhan.config.example.json` contains no real API keys or team data
- [ ] Worker example files contain no real API keys

### 3. Build Artifact Check
- [ ] No source maps in distributable files
- [ ] No debug/dev-only code in production paths
- [ ] `.npmignore` is current (even if not publishing to npm — defensive)
- [ ] `.gitignore` covers all sensitive file patterns including root-level variants
- [ ] `git diff --stat` shows no unintended files in the commit

### 4. Git History Review
- [ ] `git log --diff-filter=A --name-only` — review all newly added files since last release
- [ ] No database files, credentials, or config with real values in history
- [ ] If sensitive files were ever committed: they are removed AND the old secret is rotated

### 5. CI Pipeline Verification
- [ ] CI runs `npm audit --audit-level=high` (fails on HIGH+)
- [ ] CI runs secret scanner
- [ ] CI runs source map / sensitive file blocker
- [ ] CI smoke test passes (server starts, auth required, health check 200)
- [ ] All CI checks green before merge to main

### 6. Fresh Install Test
- [ ] Clone repo on a clean machine (or clean directory)
- [ ] Follow SETUP.md exactly — no shortcuts, no pre-existing state
- [ ] Server starts with `npm ci && node db/seed.js && node server.js`
- [ ] Login works, messages work, agents respond
- [ ] Document any issues found and fix them before release

---

## Continuous Evaluation Process

### Daily (Automated)
| Check | How | When |
|-------|-----|------|
| `npm audit` | Darkhan security worker or CI scheduled run | 0100 ET (alongside Corey audit) |
| Dependency version check | `npm outdated` in server/ | 0100 ET |
| Secret scanner | `node scripts/secret-scanner.js --startup` | Every server start |

### Weekly (Monday Morning Brief)
| Check | How | Who |
|-------|-----|-----|
| Review npm advisory feed for our dependencies | `npm audit` + manual review of high-profile CVEs | Claude (CTO) |
| Check Anthropic SDK version | Compare installed vs. latest on npm | Claude |
| Review GitHub Dependabot alerts (if enabled) | GitHub UI or `gh api` | Claude |
| Audit any new dependencies added during the week | `git log --all -- server/package.json` | Claude |
| Check for new OWASP advisories relevant to agentic AI | OWASP site + security feeds | Claude |

### Per-Release (Before Every Push to Main)
- Full pre-release checklist above
- Corey red team review of any new security-relevant code
- Fresh install dress rehearsal if >50 lines changed in server/

### Quarterly (Deep Audit)
| Check | How |
|-------|-----|
| Full dependency tree audit | `npm ls --all` — review every transitive dependency |
| License audit | Verify all dependencies are compatible with BSL 1.1 |
| Vulnerability trend analysis | Are we accumulating deps with poor security track records? |
| Pre-commit hook still installed on all contributor machines | Verify with each contributor |
| Review and update this checklist | Is anything missing? Any new attack vectors? |

---

## Incident Response: When a Vulnerability Is Found

### In Our Code
1. Assess severity (CRITICAL/HIGH/MODERATE/LOW)
2. If CRITICAL or HIGH: fix immediately, push to main, notify the project maintainer
3. Document in CHANGELOG.md
4. Add regression check to CI if applicable
5. Post to Darkhan chan_alerts

### In a Dependency
1. Check if we're affected (is the vulnerable code path exercised?)
2. If affected: upgrade, replace, or vendor-patch
3. If not affected: document why in a comment near the dependency declaration
4. If no fix available: document mitigation and add to known issues in SECURITY.md

### In Our Supply Chain (npm, Ollama, etc.)
1. Check `package-lock.json` integrity hashes — do installed packages match?
2. If compromised: `rm -rf node_modules && npm ci` from known-good lockfile
3. Rotate any credentials that may have been exposed
4. Audit server logs for unusual outbound connections
5. Post incident report to Intel/

---

## What We Fixed on 2026-03-31

| # | Issue | Fix | Vulnerabilities Resolved |
|---|-------|-----|--------------------------|
| 1 | No `npm audit` in CI | Added audit step to `ci.yml` | Prevention |
| 2 | `.gitignore` gap for `server/*.db` | Added pattern | Prevention |
| 3 | Database files tracked in git | `git rm --cached` | 0 (files were empty) |
| 4 | No pre-commit hook | Installed hook blocking .map/.db/.env/.key + secret scan + large file check | Prevention |
| 5 | No `.npmignore` | Created defensive `.npmignore` | Prevention (Anthropic-class leak) |
| 6 | `sqlite3` 5.x → 6.x | Upgraded | 2 (tar chain via node-gyp) |
| 7 | `bcrypt` 5.x → 6.x | Upgraded | 2 (tar chain via @mapbox/node-pre-gyp) |
| 8 | `connect-sqlite3` vulnerable chain | Replaced with custom `session-store.js` using sqlite3@6 | 7 (entire tar/node-gyp/cacache/http-proxy-agent chain) |
| 9 | `path-to-regexp` ReDoS | `npm audit fix` | 1 |
| 10 | `brace-expansion` hang | `npm audit fix` | 1 |
| 11 | Source map CI blocker | Added to `ci.yml` | Prevention (Anthropic-class leak) |

**Result: 11 vulnerabilities → 0 vulnerabilities. 5 new preventive controls.**

---

## Improvement Triggers

This document should be updated when:
- A new high-profile supply chain attack occurs (review if we're affected)
- A new dependency is added to Darkhan
- A new contributor gets repo access
- Corey flags a security gap in his audit
- A fresh install test fails for security-related reasons
- Any security incident occurs (ours or industry — extract lessons)

---

*Get our own house in order first. Always.*
