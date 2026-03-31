# Contributing to Darkhan

Thank you for your interest in contributing to Darkhan. This document covers how to get started, our development process, and what we expect from contributions.

## Getting Started

1. Read the [README](README.md) for architecture overview
2. Read the [SECURITY.md](SECURITY.md) for security architecture
3. Read the [WORKER-CONTRACT.md](WORKER-CONTRACT.md) for the worker runtime spec
4. Set up a local development instance following [SETUP.md](SETUP.md)

## Development Process

### Branch Strategy

- `main` — stable, deployable. All PRs target main.
- Feature branches — `feature/description` for new capabilities
- Fix branches — `fix/description` for bug fixes
- Security branches — `security/description` for security improvements (may be private)

### Pull Request Requirements

Every PR must:

1. **Pass CI** — GitHub Actions runs dependency audit (`npm audit`), secret scanner, source map blocker, syntax check, and smoke test. PRs that fail CI will not be reviewed.
2. **Pass the pre-commit hook** — install it with `cp scripts/pre-commit-hook.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`. It blocks secrets, source maps, database files, private keys, large files, and live worker configs.
3. **Describe what it does and why** — not just what files changed
4. **Not introduce security regressions** — if you touch auth, permissions, or security services, explain the security implications
5. **Not add vulnerable dependencies** — run `npm audit` before submitting. Zero HIGH+ vulnerabilities required.
6. **Include test evidence** — screenshots, terminal output, or test results showing it works
7. **Not break the hash chain** — if you modify the activity log format, ensure backward compatibility in `verify()`
8. **Not weaken credential isolation** — passwords, API keys, and PINs stay in `secrets.db`
9. **Not bypass identity enforcement** — agents must not be able to impersonate humans or each other
10. **Update CHANGELOG.md** — add your changes under the appropriate section

### Code Style

- Plain Node.js — no TypeScript, no transpilation, no bundlers
- Vanilla JS for the client — no frameworks
- `require()` not `import` (CommonJS)
- Descriptive variable names over comments
- Comments explain *why*, not *what*
- Security-relevant code gets `[DARKHAN SECURITY]` comment tags

### What We Value

- **Security first.** A feature that weakens security is not a feature.
- **Honesty over polish.** Code that accurately reports its own limitations beats code that hides them.
- **Simplicity.** If you can solve it without adding a dependency, do that.
- **Evidence.** Claims in code comments and docs should be verifiable.

## Architecture Decisions

Darkhan makes deliberate architectural choices. If your contribution changes any of these, it needs discussion first:

- **SQLite over PostgreSQL** — single-file deployment, zero configuration
- **Vanilla JS over React/Vue** — no build step, runs everywhere
- **Local LLM triage over cloud-first** — cost and privacy by default
- **Per-agent credential isolation** — workers never see secrets.db
- **Append-only activity log** — immutability is non-negotiable
- **No Docker dependency** — native OS deployment first

## Reporting Issues

Use GitHub Issues with the appropriate template:

- **Bug Report** — something isn't working as documented
- **Security Vulnerability** — see [SECURITY.md](SECURITY.md) (do NOT use public issues)
- **Feature Request** — new capability or improvement
- **Documentation** — something is unclear, wrong, or missing

## License

By contributing, you agree that your contributions will be licensed under the BSL 1.1 license. See [CLA.md](CLA.md) for the Contributor License Agreement and sign-off process.

## Questions?

Open a Discussion on GitHub or reach out to the maintainers.
