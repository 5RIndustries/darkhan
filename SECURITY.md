# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Darkhan, please report it responsibly.

**Email:** security@5rindustries.com

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

### Injection Detection
Two-tier detection: regex pattern matching (fast, always-on) plus local LLM classification for external-origin messages. High-confidence threats are blocked; suspicious content is escalated.

### Break-Glass Recovery
The admin always retains control. `break-glass.js` operates outside the security stack for emergency password reset, lockdown lift, and baseline reset. All actions are logged to the immutable audit trail.

## Known Limitations

We believe in transparency about what our security does NOT cover:

1. **Secrets.db is not encrypted at rest.** Anyone with shell access as the Darkhan user can read credentials. Planned fix: macOS Keychain or environment-variable-based encryption.
2. **Workers share the host user environment.** No OS-level sandboxing yet. Planned fix: macOS sandbox-exec profiles.
3. **SQLite triggers can be dropped** by someone with direct `sqlite3` CLI access. The hash chain provides tamper detection but not tamper prevention at the database level.
4. **Federation (Mokume) is designed but not yet deployed.** Cross-instance security features are implemented but untested in production federation.
5. **No TLS on localhost.** Tailscale encrypts inter-node traffic, but local connections are plaintext. Acceptable for single-machine deployment; requires mTLS for multi-machine without VPN.

## Supported Versions

| Version | Supported |
|---------|-----------|
| main branch | Yes |
| All others | No |

We are pre-release. Security updates are applied to `main` only.
