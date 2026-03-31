# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Darkhan, please report it responsibly.

**Email:** security@yourdomain.com

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
| **Credential theft** | Agent attempts to read or leak API keys, passwords, or secrets | Credential isolation (separate database), env var whitelist, outbound leak scanning |
| **Identity spoofing** | Agent impersonates a human or another agent | Identity enforcement at the message layer; impersonation triggers lockdown |
| **Tool abuse** | Runaway loops, file deletion, unauthorized network access | Per-tool rate limits, shell restrictions, network egress deny-default, file write permissions |
| **Model poisoning** | Tampered Ollama model files | SHA-256 model file verification at startup |
| **Database tampering** | Direct modification of lockdown state or audit trail | HMAC-signed lockdown state, hash chain with SQLite delete/update triggers |
| **Frontier-model injection (Mythos-class)** | Injection crafted by a model more capable than any single classifier | Two-LLM consensus (local + cloud must agree); disagreement quarantines for human review |

### What Darkhan Does NOT Defend Against

We believe in transparency. These are real limitations, not theoretical edge cases:

1. **Host compromise.** If an attacker has shell access to the machine as the Darkhan service user or root, they can read the database, modify files, and bypass all application-level controls. Darkhan is an application-level defense, not an OS-level one.
2. **Supply chain attacks.** We do not audit every npm dependency, Ollama model weight, or Node.js patch. A compromised dependency could bypass all Darkhan controls.
3. **Coordinated cloud provider compromise.** The two-LLM consensus assumes the local and cloud classifiers are independent. If both providers are compromised or colluding, consensus is meaningless.
4. **Adversarial inputs tuned to the specific local model.** An attacker who knows exactly which Ollama model is running could craft adversarial token sequences that reliably fool that model. The cloud classifier mitigates this, but does not eliminate it.
5. **Social engineering of the human admin.** Darkhan cannot prevent a human from approving a malicious action, unlocking lockdown when they should not, or running commands they were tricked into running.
6. **Secrets.db encryption at rest.** The secrets database file is not encrypted. Anyone who can read it as the owning user can extract password hashes and API keys. macOS Keychain (Layer 3 hardening) mitigates this but is optional.
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
Security events (injection attempts, lockdown triggers, exfiltration attempts) automatically create defense spacer entries in the hash chain. In federated deployments, spacers propagate to peer instances via Mokume.

### Credential Isolation
Passwords, API keys, and PINs are stored in a separate `secrets.db` database (mode 600) that workers never receive access to.

### Fail-Closed Lockdown
Security events trigger automatic lockdown. All agent traffic is blocked until a human admin unlocks with a PIN via the web UI. Lockdown state is signed to prevent tampering.

### File Integrity Monitoring
Critical server files are SHA-256 hashed at startup and verified against an external baseline. Modified files trigger automatic lockdown.

### LLM Model Verification
At startup, `model-verifier.js` computes SHA-256 digests of Ollama model files and compares them against the digests stored in the Ollama manifest. This detects tampered or corrupted model downloads before they are used for inference. Uses streaming hash computation to handle multi-GB files efficiently.

### Injection Detection
Multi-layer detection: regex pattern matching (fast, always-on) for all messages, content normalization to strip encoding tricks, and two-LLM consensus classification for external and agent-origin messages. Critical threats are blocked. Classifier disagreement triggers quarantine. Suspicious content is flagged.

### Pre-Commit Secret Scanner
A git pre-commit hook (`.githooks/pre-commit`) runs `secret-scanner.js` on every staged diff. It catches API keys (AWS, Google, Anthropic, OpenAI, Azure, GitHub, Slack, Telegram, Darkhan), private keys, JWTs, database connection strings, and hardcoded secret assignments. Commits containing secrets are blocked with clear remediation instructions.

### Break-Glass Recovery
The admin always retains control. `break-glass.js` operates outside the security stack for emergency password reset, lockdown lift, and baseline reset. All actions are logged to the immutable audit trail.

## Known Limitations

We believe in transparency about what our security does NOT cover. See also the "What Darkhan Does NOT Defend Against" section in the Threat Model above.

1. **Secrets.db is not encrypted at rest.** Anyone with shell access as the Darkhan user can read credentials. Mitigated by macOS Keychain integration (Layer 3 hardening), but the database itself is not encrypted.
2. **SQLite triggers can be dropped** by someone with direct `sqlite3` CLI access. The hash chain provides tamper detection but not tamper prevention at the database level.
3. **Federation (Mokume) is designed but not yet deployed.** Cross-instance security features are implemented but untested in production federation.
4. **No TLS on localhost.** Tailscale encrypts inter-node traffic, but local connections are plaintext. Acceptable for single-machine deployment; mTLS is available for multi-machine without VPN.
5. **macOS sandbox only.** Process isolation via `sandbox-exec` is macOS-specific. Linux and Windows deployments do not yet have equivalent OS-level sandboxing.
6. **Two-LLM consensus requires a cloud API key.** Without `SECURITY_ESCALATION_PROVIDER` configured, messages are classified by a single local model only. Single-model classification is logged as `safe_single` so you know the reduced confidence level.
7. **Consensus fail-open on total LLM unavailability.** If both the local Ollama model and the cloud provider are unreachable, messages are flagged but not blocked. This prioritizes availability over safety in that edge case.
8. **Regex patterns are not exhaustive.** The injection pattern list covers common attack vectors but cannot anticipate every possible injection technique. The LLM classifiers are the deeper defense layer.

## Supported Versions

| Version | Supported |
|---------|-----------|
| main branch | Yes |
| All others | No |

We are pre-release. Security updates are applied to `main` only.
