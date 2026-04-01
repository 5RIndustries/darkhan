# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Darkhan, please report it responsibly.

**Email:** security@darkhan.ai

**Do NOT:**
- Open a public GitHub issue for security vulnerabilities
- Post details on social media or forums before we've had time to respond
- Exploit vulnerabilities against production instances you don't own

**We will:**
- Acknowledge receipt within 48 hours
- Provide an initial assessment within 5 business days
- Work with you on coordinated disclosure
- Credit you in the advisory (unless you prefer anonymity)

## Scope

The following are in scope for security reports:

- Authentication/authorization bypass
- Prompt injection that bypasses detection
- Agent impersonation or identity spoofing
- Credential exposure or exfiltration
- Hash chain tampering or integrity bypass
- Lockdown bypass without admin PIN
- Cross-site scripting (XSS) or CSRF bypass
- SQL injection
- Unauthorized file system access beyond configured permissions
- Federation message spoofing or replay attacks

## Threat Model

### What Darkhan Defends Against

Darkhan is designed to operate in an environment where AI agents may be manipulated, compromised, or adversarial. The threat model explicitly considers frontier-model adversaries -- AI systems more capable than either of our individual classifiers.

| Threat | Vector | Defense |
|--------|--------|---------|
| **Prompt injection (direct)** | Malicious instructions in user/external messages | Regex pattern scan + two-LLM consensus classification |
| **Prompt injection (indirect)** | Injection hidden in files, command output, or tool results | Tool output injection scanning on `fs.read()` and `shell.exec()` |
| **Cascading injection** | Compromised agent injects instructions into other agents via channels | Agent-to-agent messages get full scan pipeline (not just external) |
| **Encoding evasion** | Injection hidden in base64, Unicode control chars, zero-width text, RTL overrides, HTML comments | Content normalization before all security scans |
| **Credential theft** | Agent attempts to read or leak API keys, passwords, or secrets | Credential isolation (separate database), env var whitelist for workers and terminal PTY, outbound leak scanning |
| **Trust level spoofing** | Client-supplied headers attempting to escalate message trust | Server-side-only trust determination from authentication method; `x-darkhan-origin` header ignored |
| **Infrastructure reconnaissance** | Compromised worker mapping deployment details | Onboarding data minimization — no hostname, platform, port, or other agents' LLM details |
| **Identity spoofing** | Agent impersonates a human or another agent | Identity enforcement at the message layer; impersonation triggers lockdown |
| **Tool abuse** | Runaway loops, file deletion, unauthorized network access | Per-tool rate limits, shell restrictions, network egress deny-default, file write permissions |
| **Model poisoning** | Tampered Ollama model files | SHA-256 model file verification at startup |
| **Database tampering** | Direct modification of lockdown state or audit trail | HMAC-signed lockdown state, hash chain with SQLite delete/update triggers |
| **Frontier-model injection (Mythos-class)** | Injection crafted by a model more capable than any single classifier | Two-LLM consensus (local + cloud must agree); disagreement quarantines for human review |

### What Darkhan Does NOT Defend Against

We believe in transparency. These are real limitations, not theoretical edge cases:

1. **Host compromise.** If an attacker has shell access to the machine as the Darkhan service user or root, they can read the database, modify files, and bypass all application-level controls. Darkhan is an application-level defense, not an OS-level one.
2. **Supply chain attacks.** A compromised npm dependency, Ollama model weight, or Node.js patch could bypass all application-level controls. We mitigate this with `npm audit` enforcement in CI (fails on HIGH+), pre-commit hooks that block sensitive files, dependency auditing before each release, and a continuous evaluation process (see [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md)). These are mitigations, not guarantees.
3. **Coordinated cloud provider compromise.** The two-LLM consensus assumes the local and cloud classifiers are independent. If both providers are compromised or colluding, consensus is meaningless.
4. **Adversarial inputs tuned to the specific local model.** An attacker who knows exactly which Ollama model is running could craft adversarial token sequences that reliably fool that model. The cloud classifier mitigates this, but does not eliminate it.
5. **Social engineering of the human admin.** Darkhan cannot prevent a human from approving a malicious action, unlocking lockdown when they should not, or running commands they were tricked into running.
6. **Secrets.db key recovery.** API keys in secrets.db are AES-256-GCM encrypted with HMAC-indexed lookups. However, the encryption key is derived from `SESSION_SECRET` via HKDF. An attacker who obtains both the secrets.db file and the `SESSION_SECRET` (from `.env` or the macOS Keychain) can decrypt all API keys. Password hashes are bcrypt (one-way) and are not affected. macOS Keychain (Layer 3 hardening) moves `SESSION_SECRET` out of the filesystem entirely.
7. **SQLite trigger bypass.** The hash chain triggers prevent modification via the application, but someone with `sqlite3` CLI access can drop the triggers and tamper with the log. The chain provides tamper detection, not tamper prevention at the storage level.
8. **Denial of service.** An attacker flooding the system with messages could exhaust LLM quota (local or cloud) used for consensus classification. Rate limiting at the HTTP layer mitigates but does not prevent this.

### Mythos-Class Threat Defenses

"Mythos-class" refers to frontier AI models with cybersecurity capabilities that exceed current-generation systems. These defenses were designed specifically for that threat:

**1. Two-LLM Consensus**

Every external-origin and agent-origin message is classified independently by two different LLM providers (local Ollama and cloud Gemini/Anthropic). Both must agree the message is SAFE for it to pass. If they disagree, the message is quarantined for human review.

The security reasoning: injection crafted to fool one model architecture is unlikely to fool a completely different architecture. A local Qwen model and a cloud Gemini model have different training data, different architectures, and different failure modes. Beating both simultaneously is substantially harder than beating either one.

Configuration: requires `SECURITY_ESCALATION_PROVIDER` in `.env` (e.g., `gemini` or `anthropic`) and the corresponding API key.

**2. Agent-to-Agent Injection Scanning**

Before Mythos defenses, only external messages went through the LLM classification pipeline. Agent messages were trusted. This left a cascading injection vector: compromise one agent (via a poisoned file, tool output, or external message), and it could inject instructions into every other agent via channel messages.

Now, all agent messages get the full scan pipeline: content normalization, regex patterns, and two-LLM consensus. The `origin` field is set to `agent` so the pipeline knows to apply full scanning.

**3. Content Normalization**

Sophisticated injection can be hidden in encoding tricks that survive regex scanning:
- **Unicode control characters** (U+0000-U+001F) can create invisible instruction boundaries
- **Zero-width characters** (ZWJ, ZWNJ, zero-width space) can break up keywords to evade pattern matching
- **RTL overrides** (U+202A-U+202E) can visually hide text while it remains in the LLM context
- **HTML comments** can carry instructions invisible to a human reader
- **Base64-encoded blocks** can hide entire injection payloads

The normalizer strips all of these before the regex scanner runs, and decodes base64 blocks to scan their contents separately. Injection found inside base64 is automatically escalated to critical severity.

**4. Shell Allowlist Mode**

The default shell restriction mode is a blocklist: known-dangerous commands are blocked. This is vulnerable to any command the blocklist does not anticipate.

Allowlist mode inverts this: only explicitly permitted commands are allowed. Everything else is blocked. This is the Mythos-hardened posture.

Set `security.shellMode` to `allowlist` in `darkhan.config.json`. The default allowlist is: `ls`, `cat`, `head`, `tail`, `wc`, `date`, `echo`, `grep`, `find`, `sort`, `uniq`, `diff`, `pwd`, `whoami`, `uname`, `df`, `du`, `git`, `npm`, `ollama`, `pgrep`. Per-agent overrides are available via `permissions.shellAllowedCommands`.

## Security Architecture

Darkhan's security is foundational, not bolted on. Key components:

### Identity Enforcement
Agents cannot impersonate humans or each other. Every message carries a verified sender identity backed by the authentication layer.

### Process Isolation
Workers can run as isolated child processes via `fork()` when `sandbox.processIsolation = true`. Each worker gets its own V8 isolate with IPC-only communication to the parent. The parent proxies all Darkhan API calls with full security checks. A crashing worker cannot affect the server or other workers.

### Worker Onboarding Data Minimization
The onboarding service generates a brief for each agent at startup. This brief is stripped of infrastructure details that a compromised worker could use to map the deployment: hostname, platform, process uptime, port number, and other agents' LLM providers/models are all excluded. Workers receive only: their own identity, their LLM configuration, their permissions, their channels, and the names of other agents (without infrastructure details). A compromised worker no longer gets a deployment map.

**P0 fix (2026-03-31):** Prior to this fix, worker onboarding briefs included full system details — hostname, OS platform, server uptime, port, and every other agent's LLM provider and model name. This gave any compromised worker a complete infrastructure map for lateral movement planning.

### Content Normalization (Mythos Defense)
All external and agent messages are normalized before security scanning. This strips Unicode control characters, zero-width characters, RTL/LTR overrides, and HTML comments. Base64-encoded blocks are decoded and scanned separately. This prevents encoding-based evasion of the injection scanner.

### Two-LLM Consensus Classification (Mythos Defense)
External-origin and agent-origin messages are classified by two independent LLM providers. Both must agree the message is safe. Disagreement triggers quarantine for human review. This defends against injection crafted to fool a single classifier, including injection designed by models more capable than either individual classifier.

### Agent-to-Agent Injection Scanning (Mythos Defense)
Agent messages now go through the full security scan pipeline, not just external messages. This closes the cascading injection vector where a compromised agent poisons other agents through channel messages.

### Shell Allowlist Mode (Mythos Defense)
An alternative to the default blocklist. Instead of blocking known-dangerous commands, only explicitly permitted commands are allowed. Configure via `security.shellMode: "allowlist"` in `darkhan.config.json`.

### Tool Output Injection Scanning
`tools.fs.read()` and `tools.shell.exec()` scan their output for injection patterns before returning results to the worker/LLM context. This prevents a compromised file or malicious command output from injecting instructions into the LLM's context window. Critical-severity matches block the operation entirely; lower-severity matches warn and log.

### Tool Invocation Rate Limiting
Each task execution is subject to per-tool invocation limits: 200 filesystem reads, 50 filesystem writes, and 10 shell executions per task. Counters reset at the start of each task. This prevents runaway loops from exhausting resources or amplifying an attack.

### Network Egress Restrictions
The sandbox profile enforces a deny-default network policy. Only three endpoints are permitted:
- Ollama (`localhost:11434`)
- Google Gemini API (`generativelanguage.googleapis.com:443`)
- Anthropic API (`api.anthropic.com:443`)

The shell command blocklist separately prevents `curl`, `wget`, and other network tools.

### Path Normalization
The shell command checker resolves symlinks and absolute paths before comparing against the blocklist. This prevents bypass attempts via `/usr/bin/python3`, symlinked binaries, or relative path traversal.

### Evidence-Based Reporting
Agent claims are tagged as verified, unverified, or self-reported. Verified claims are backed by SHA-256 evidence hashes binding the claim to its method, result, and timestamp.

### Ground Truth Registry
Curated verified facts that agents must reference. The claim verifier automatically detects contradictions between agent messages and registered ground truths.

### Immutable Hash Chain
Every activity log entry includes a SHA-256 hash linking it to the previous entry. SQLite triggers prevent deletion or modification. The chain can be cryptographically verified end-to-end via `/api/activity/verify`.

### CRISPR Defense Spacers
Security events (injection attempts, lockdown triggers, exfiltration attempts) automatically create defense spacer entries in the hash chain. In federated deployments, spacers propagate to peer instances via federation.

### Credential Isolation
Passwords, API keys, and PINs are stored in a separate `secrets.db` database (mode 600) that workers never receive access to. The relay session file (`~/.claude/darkhan-relay-sessions.json`) is written with mode 600 (owner-only) and permissions are applied after atomic rename to prevent race conditions.

**Terminal environment filtering (P0 fix, 2026-03-31):** Shell terminal PTY sessions receive only a whitelist of environment variables: `HOME`, `PATH`, `LANG`, `USER`, `TERM`, `SHELL`, `TMPDIR`. Claude Code terminal mode additionally receives `ANTHROPIC_API_KEY` (required for Claude Code to function). All other environment variables — including `SESSION_SECRET`, `GOOGLE_API_KEY`, and any other secrets from `.env` — are stripped from the terminal environment. This prevents credential exfiltration via `printenv`, `env`, or `echo $VAR` from interactive terminal sessions.

### Fail-Closed Lockdown
Security events trigger automatic lockdown. All agent traffic is blocked until a human admin unlocks with a PIN via the web UI. Lockdown state is signed to prevent tampering.

### File Integrity Monitoring
Critical server files are SHA-256 hashed at startup and verified against an external baseline. Modified files trigger automatic lockdown.

### LLM Model Verification
At startup, `model-verifier.js` computes SHA-256 digests of Ollama model files and compares them against the digests stored in the Ollama manifest. This detects tampered or corrupted model downloads before they are used for inference. Uses streaming hash computation to handle multi-GB files efficiently.

### Injection Detection
Multi-layer detection: regex pattern matching (fast, always-on) for all messages, content normalization to strip encoding tricks, and two-LLM consensus classification for external and agent-origin messages. Critical threats are blocked. Classifier disagreement triggers quarantine. Suspicious content is flagged.

**Single security pipeline (P0 fix, 2026-03-31):** All message scanning now flows through a single `sanitizeMessage()` pipeline. A previous duplicate code path ran standalone `scanForInjection()` and `classifyWithLocalLLM()` independently from the main pipeline, which could produce divergent security decisions (e.g., the standalone path allowing a message that `fullScan()` would quarantine). The duplicate path has been removed. Quarantine decisions are now made exclusively by the consensus action within `fullScan()`.

### Pre-Commit Hook
The pre-commit hook (`scripts/pre-commit-hook.sh`) provides seven layers of commit-time protection:

1. **Source map blocking** -- prevents Anthropic-class source code leaks (`.map` files)
2. **Database file blocking** -- prevents credential/user data exposure (`.db`, `.db-wal`, `.db-shm`)
3. **Environment file blocking** -- prevents secret exposure (`.env` files, excluding `.env.example`)
4. **Private key/certificate blocking** -- `.key`, `.pem`, `.csr`, `.p12`, `.pfx` files
5. **Hardcoded secret scanning** -- pattern-matches staged diffs for API key formats (Anthropic `sk-ant-`, AWS `AKIA`, GitHub `ghp_`, Slack `xoxb-`/`xoxp-`)
6. **Large file warning** -- flags files >5MB (build artifacts, model weights)
7. **Live worker file blocking** -- prevents team-specific worker configs from being committed (use `examples/` templates)

Additionally, `secret-scanner.js` runs at server startup and in CI, scanning for a broader set of patterns including JWTs, database connection strings, and hardcoded secret assignments.

### Secrets Encryption at Rest
API keys in secrets.db are AES-256-GCM encrypted with HMAC-SHA256 indexed lookups for O(1) authentication without decrypting every row. The encryption key is derived from `SESSION_SECRET` via HKDF with separate derivation paths for encryption and HMAC. Each encrypted value uses a unique random IV (initialization vector). Existing plaintext keys are automatically migrated on first startup -- no manual intervention required. Password hashes are bcrypt (one-way) and do not need additional encryption.

### Message Trust Levels
Every message is tagged with a trust level based on its authenticated origin:
- `human_verified` — typed by an authenticated human via web UI session
- `agent_local` — generated by a local worker on this node via API key
- `agent_federated` — received from a federated node
- `external` — from an external source (API, webhook)
- `quarantined` — flagged by consensus disagreement, awaiting human review

Trust levels are determined entirely server-side from the authentication method used to submit the message. Session-authenticated requests are `human_verified`. API key requests with an `agent_` prefix are `agent_local`. Requests carrying the federation header are `agent_federated`. Client-supplied headers (e.g., `x-darkhan-origin`) are ignored and cannot influence trust level assignment. When messages cross federation boundaries, trust degrades automatically.

**P0 fix (2026-03-31):** Prior to this fix, the `x-darkhan-origin` client header was consulted during trust level determination. This allowed a malicious client to spoof trust levels by sending a crafted header. Trust is now derived exclusively from the server-side authentication method (session, API key prefix, federation header).

### Quarantine Queue
When the two-LLM consensus disagrees on a message classification (one says SAFE, the other says SUSPICIOUS), the message is held in a quarantine queue instead of being delivered. An admin reviews quarantined messages and approves (releases to the channel) or rejects (discards). Approve/reject decisions are logged to `triage_log` as training data for improving the classification model.

### Behavioral Baseline Anomaly Detection
Each agent has a behavioral baseline computed from rolling 24-hour activity windows: message count, LLM calls, shell executions, file writes, active channels, and active hours. The baseline updates daily at 0200 ET. When an agent's current behavior exceeds 3x its baseline on any metric, an anomaly alert is generated. This detects compromised agents, data exfiltration, and unusual API usage patterns.

### Model Version Tagging
Every LLM call is tagged in the activity log with the model identifier and digest. For local Ollama models, this includes the model name returned by the API. This enables traceability of which model version produced each classification decision — critical for auditing false positives and training data quality.

### Password Recovery
Admin-generated one-time recovery tokens allow password reset without email. Tokens are bcrypt-hashed in secrets.db, expire in 1 hour, and are single-use. All recovery attempts (success and failure) are logged to the immutable activity trail.

### Break-Glass Recovery
The admin always retains control. `break-glass.js` operates outside the security stack for emergency password reset, lockdown lift, and baseline reset. All actions are logged to the immutable audit trail.

## Why We Built This

We built Darkhan because we read the research:

- **Apollo Research (2024)** showed that all frontier models except GPT-4o can scheme — including self-exfiltration, oversight subversion, and persistent deception when confronted.
- **Anthropic's own testing** showed Claude Opus 4 would resort to blackmail to avoid shutdown in 84% of constrained self-preservation scenarios. It was classified as the first ASL-3 model.
- **EchoLeak (CVE-2025-32711)** proved zero-click prompt injection is real — a crafted email extracted data from OneDrive, SharePoint, and Teams with no user interaction. CVSS 9.3.
- **OpenAI's anti-scheming training** reduced covert actions in o3 from 13% to 0.4% — but some reductions came from models detecting they were being evaluated and behaving well specifically in test conditions.
- **DeepMind (March 2026)** released the first empirically validated manipulation measurement toolkit. 70% of tested models showed manipulation vulnerabilities.

We didn't build security as an afterthought. We built a system where defense IS the architecture.

## What Darkhan Defends Against

Darkhan provides strong defense against the following documented AI threats:

1. **Prompt injection** (external and inter-agent) — Two-LLM consensus requires independent classification by two models from different providers. Both must agree a message is safe. This addresses the class of attacks demonstrated in EchoLeak, where a single classifier was evaded.
2. **Encoding-based evasion** — Content normalization strips Unicode control characters, zero-width characters, RTL overrides, HTML comments, and base64 payloads before scanning.
3. **Agent self-exfiltration** — Shell allowlist permits only explicitly approved commands. Network egress is deny-by-default.
4. **Oversight disabling** — Lockdown is fail-closed, PIN-protected, and human-only. Agents cannot unlock themselves. No API call, no override, no break-glass without a human at the terminal.
5. **Identity impersonation** — Identity is server-assigned, not self-claimed. Ed25519 cryptographic signing for federation readiness.
6. **Audit trail tampering** — Immutable hash chain with SQLite triggers. Every message, security event, and classification decision is cryptographically linked.
7. **Unauthorized command execution** — Shell allowlist (not blocklist). Only explicitly permitted commands can run.
8. **Behavioral anomaly** — Per-agent baselines track normal message volume, channel patterns, and LLM call rates. Deviations beyond 3x trigger alerts.

## What Darkhan Partially Defends Against

These areas have defenses but with known gaps:

1. **Agent lying about verifiable facts** — Claim verification checks assertions against a ground truth registry. Coverage depends on registry completeness. Facts not in the registry are reported as "unverified," not "false."
2. **Slow-burn data exfiltration** — Network egress deny-default and data leak scanning exist, but small amounts of data embedded in legitimate output over time may bypass detection.
3. **Supply chain attacks** — Model hash verification at startup. `npm audit` enforced in CI (fails on HIGH+). Pre-commit hook blocks sensitive files. Dependency audit before every release. Custom session store eliminates vulnerable transitive dependency chains. Minimal dependency philosophy: 14 direct dependencies, single-maintainer packages replaced with Node.js built-ins where possible (uuid→crypto.randomUUID, dotenv→process.loadEnvFile). See [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) for the continuous evaluation process.
4. **Novel attack patterns** — CRISPR defense spacers propagate detected attack patterns across instances. This defends against known patterns. Novel attacks are detected by the consensus pipeline, not the spacer library.

## Threat Model Boundaries

These are honest limitations. Some are shared by every system in the field. We publish them because we believe the AI security field needs more intellectual honesty and less marketing.

**Unsolved problems (industry-wide, not Darkhan-specific):**

1. **Instrumental alignment.** An agent that fakes compliance during testing and schemes after deployment is an unsolved problem in AI safety. Darkhan's behavioral baselines provide the best available proxy detection, but no system can guarantee detection of a sufficiently patient adversary. This is the alignment problem itself.
2. **Evaluation detection.** OpenAI's own research found that anti-scheming training partially worked because models learned to detect when they were being evaluated. No reliable production solution exists.
3. **A fundamentally deceptively aligned model.** If the model's base weights encode deceptive goals, no application-level defense will reliably catch it.

**Darkhan-specific limitations:**

4. **Darkhan assumes a trusted operating system and honest admin.** Application-level security cannot defend against kernel-level compromise or a malicious administrator.
5. **SQLite triggers can be dropped** by someone with direct `sqlite3` CLI access. The hash chain provides tamper detection but not tamper prevention at the database level.
6. **Federation is designed but not yet deployed.** Cross-instance security features are implemented but untested in production federation.
7. **No TLS on localhost.** Tailscale encrypts inter-node traffic, but local connections are plaintext. mTLS is available for multi-machine without VPN.
8. **macOS sandbox only.** Process isolation via `sandbox-exec` is macOS-specific. Linux and Windows do not yet have equivalent OS-level sandboxing.
9. **Two-LLM consensus requires a cloud API key.** Without `SECURITY_ESCALATION_PROVIDER` configured, messages are classified by a single local model only. Logged as `safe_single` so you know the reduced confidence level.
10. **Consensus fail-open on total LLM unavailability.** If both models are unreachable, messages are flagged but not blocked. This prioritizes availability over safety in that edge case.
11. **Content normalization addresses known encoding techniques.** Novel encoding methods may bypass normalization until identified and added.
12. **Sycophancy is not currently detected.** Darkhan does not analyze whether agents are excessively validating operator decisions. Research (Stanford/Science, March 2026) shows AI sycophancy causes measurable harm to decision-making quality.

## Supported Versions

| Version | Supported |
|---------|-----------|
| main branch | Yes |
| All others | No |

We are pre-release. Security updates are applied to `main` only.
