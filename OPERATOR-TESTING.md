# Operator Testing Protocol

> How agents and operators verify Darkhan's behavior without compromising user credentials or violating privilege boundaries.

## The Problem

An AI agent (Claude, Corey, or any operator) needs to verify that Darkhan is working correctly. But testing typically requires authentication — logging in, sending messages, checking responses. An agent that guesses passwords, reads credential stores, or impersonates users to test the system is violating the same trust boundaries the system is designed to protect.

## The Principle

**Test through observable side effects, not through authentication.**

A system that's working correctly produces observable evidence of that fact. A system that's broken produces observable evidence of that too. You don't need to be logged in to check whether the server started, whether processes spawned correctly, or whether logs show the right sequence of events.

## Authorized Testing Methods

### Tier 1: Zero-Privilege (no credentials needed)

These tests require no authentication and reveal no sensitive data:

| Method | What It Verifies | Command |
|--------|-----------------|---------|
| **Process check** | Server is running | `pgrep -f "darkhan/server"` |
| **Port check** | Server is listening | `lsof -i :3001` |
| **HTTP status** | Web UI is serving | `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/` |
| **Claude process count** | No orphan/duplicate sessions | `pgrep -fl "claude" \| grep -v telegram \| wc -l` |
| **Log inspection** | Startup sequence, errors, routing decisions | `cat ~/Library/Logs/darkhan-server.log \| tail -N` |
| **Process CPU/memory** | Session health (stuck = 0% CPU) | `ps aux \| grep PID` |
| **File existence** | Session persistence working | `ls ~/.claude/darkhan-unified-sessions.json` |
| **Config validation** | Config is parseable | `node -e "require('./darkhan.config.json')"` |
| **Syntax check** | Code compiles after changes | `node -e "require('./services/file.js')"` |
| **Dependency audit** | No known vulnerabilities | `npm audit` |

### Tier 2: Read-Only Observation (log analysis)

Parse server logs to verify behavior without triggering any actions:

| Pattern | What It Proves |
|---------|---------------|
| `grep "Session created" logs` | Session was created (and how many times — duplicates = bug) |
| `grep "Turn complete" logs` | Claude responded (and response length — 0 chars = bug) |
| `grep "Posted to chan_command" logs` | Response was delivered to the channel |
| `grep "subscribers=" logs` | Subscribers were attached when response arrived (0 = bug) |
| `grep "error\|Error" logs` | Any errors during processing |
| `grep "Triggered for" logs` | Message was received and routed |
| Absence of log entries | Eager behavior didn't fire (e.g., no session on startup = correct) |

### Tier 3: Health Endpoints (authenticated but non-destructive)

These require an API key but don't modify state:

| Endpoint | What It Returns |
|----------|----------------|
| `GET /api/health/status` | Server health, uptime, worker status |
| `GET /api/health/workers` | Worker runtime state (running, idle, disabled) |
| `GET /api/health/terminal` | Terminal session state |

**Rule:** An agent may use its own API key (configured in its worker definition) to call health endpoints. An agent must NEVER use the admin's API key, password, or PIN.

### Tier 4: Delegated Testing (human provides access)

When authentication is required for a test that can't be done through observation:

1. **Ask the human.** Explain what you need to test and why.
2. **Request a test token.** The human generates a one-time API key or provides a test account.
3. **Never store the token.** Use it for the immediate test, then discard.
4. **Report results.** Tell the human what you tested and what you found.

## What Agents Must NEVER Do

| Action | Why It's Prohibited |
|--------|-------------------|
| **Guess passwords** | Brute-force attempts trigger lockdown and violate trust |
| **Read secrets.db** | Credential store is architecturally isolated from agents |
| **Read .env file for credentials** | API keys and secrets belong to the admin |
| **Use admin's API key** | Impersonation — even for testing — is a trust violation |
| **Create test users** | Modifies auth state without permission |
| **Send messages as another user** | Identity impersonation |
| **Bypass auth middleware** | Even if you can see the code path, exploiting it is a violation |
| **Read session cookies from logs** | Session hijacking |

## The Decision Framework

When you need to verify something about Darkhan:

```
Can I check it through process state or logs?
  → YES → Do it (Tier 1-2)
  → NO ↓

Can I use a health endpoint with my own API key?
  → YES → Do it (Tier 3)
  → NO ↓

Does the test require user-level authentication?
  → YES → Ask the human for a test token (Tier 4)
  → NO → Re-examine whether the test is actually necessary
```

## Example: What Claude Did Right

When testing the unified session fix on 2026-04-01, Claude needed to verify that the server wasn't eagerly spawning Claude processes on startup. Instead of logging in and sending a test message:

1. **Checked process count** (`pgrep -fl "claude" | wc -l`) — found 0 Claude processes. Confirmed no eager spawn.
2. **Read server logs** — saw `Loaded 1 stored session(s)` but no `Session created` or `Resumed`. Confirmed lazy initialization.
3. **Attempted API auth** — tried `curl` to the login endpoint but didn't have credentials. **Stopped immediately** instead of guessing.
4. **Reported honestly** — told the admin "I can't fully test the chat flow without your credentials" and asked them to test.

This verified the fix without compromising any credentials.

## Implementation in Darkhan

### For Worker Agents
Workers already operate within sandboxed permissions. They cannot read secrets.db, .env, or other workers' configurations. This protocol extends that principle to testing: agents verify through observation, not authentication.

### For Operators (Claude Code, SSH users)
Operators have broader system access but must still respect authentication boundaries. Having the ability to read a file doesn't grant permission to use its contents. The protocol above applies to all operators regardless of their filesystem access level.

### For Red Team (Corey)
Corey's adversarial testing has an explicit mandate to probe security boundaries. However, Corey:
- Tests from OUTSIDE the trust boundary (simulating an attacker)
- Reports findings to the admin (not self-remediates with stolen credentials)
- Uses the Siege agent or HTTP probes, not admin credentials

## Adding This to Darkhan's Architecture

This protocol should be enforced at three levels:

1. **Documentation** — This file. Operators read it and follow it.
2. **Code review** — Any PR that reads secrets.db, .env, or uses admin auth tokens is flagged.
3. **AEP integration** — The Action-Evidence Protocol could track `AUTHENTICATED_AS` evidence. If an agent authenticates as someone other than itself, the evidence trail shows it.

---

*This protocol was developed after Claude demonstrated zero-privilege testing during the Darkhan unified session debugging session (2026-04-01). The pattern proved that comprehensive system verification is possible without any credential access.*
