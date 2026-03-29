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

## Security Architecture

Darkhan's security is foundational, not bolted on. Key components:

### Identity Enforcement
Agents cannot impersonate humans or each other. Every message carries a verified sender identity backed by the authentication layer.

### Process Isolation
Workers can run as isolated child processes via `fork()` when `sandbox.processIsolation = true`. Each worker gets its own V8 isolate with IPC-only communication to the parent. The parent proxies all Darkhan API calls with full security checks. A crashing worker cannot affect the server or other workers.

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
Two-tier detection: regex pattern matching (fast, always-on) plus local LLM classification for external-origin messages. High-confidence threats are blocked; suspicious content is escalated.

### Pre-Commit Secret Scanner
A git pre-commit hook (`.githooks/pre-commit`) runs `secret-scanner.js` on every staged diff. It catches API keys (AWS, Google, Anthropic, OpenAI, Azure, GitHub, Slack, Telegram, Darkhan), private keys, JWTs, database connection strings, and hardcoded secret assignments. Commits containing secrets are blocked with clear remediation instructions.

### Break-Glass Recovery
The admin always retains control. `break-glass.js` operates outside the security stack for emergency password reset, lockdown lift, and baseline reset. All actions are logged to the immutable audit trail.

## Known Limitations

We believe in transparency about what our security does NOT cover:

1. **Secrets.db is not encrypted at rest.** Anyone with shell access as the Darkhan user can read credentials. Mitigated by macOS Keychain integration (Layer 3 hardening), but the database itself is not encrypted.
2. **SQLite triggers can be dropped** by someone with direct `sqlite3` CLI access. The hash chain provides tamper detection but not tamper prevention at the database level.
3. **Federation (Mokume) is designed but not yet deployed.** Cross-instance security features are implemented but untested in production federation.
4. **No TLS on localhost.** Tailscale encrypts inter-node traffic, but local connections are plaintext. Acceptable for single-machine deployment; mTLS is available for multi-machine without VPN.
5. **macOS sandbox only.** Process isolation via `sandbox-exec` is macOS-specific. Linux and Windows deployments do not yet have equivalent OS-level sandboxing.

## Supported Versions

| Version | Supported |
|---------|-----------|
| main branch | Yes |
| All others | No |

We are pre-release. Security updates are applied to `main` only.
