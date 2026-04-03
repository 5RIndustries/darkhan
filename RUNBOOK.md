# Darkhan — Operations Runbook

> Operational procedures for running, maintaining, and recovering Darkhan.
> Keep this next to your terminal. These are the commands you'll actually use.
>
> **Note:** `$DARKHAN_PATH` refers to your Darkhan installation directory (e.g., `~/darkhan`).

---

## Table of Contents

1. [Starting and Stopping](#starting-and-stopping)
2. [After Code Changes (Development Cycle)](#after-code-changes)
3. [Break-Glass Recovery](#break-glass-recovery)
4. [Lockdown Recovery](#lockdown-recovery)
5. [Adding a New Agent](#adding-a-new-agent)
6. [Connecting a Second Instance (Federation)](#connecting-a-second-instance)
7. [Backup and Restore](#backup-and-restore)
8. [Certificate Management](#certificate-management)
9. [Process Isolation](#process-isolation)
10. [Maintenance](#maintenance)
11. [Pre-Commit Hook and Secret Scanner](#pre-commit-hook-and-secret-scanner)
12. [Model Verification](#model-verification)
13. [Common Issues](#common-issues)

---

## Starting and Stopping

### Start (production — as service user)

```bash
sudo -u _darkhan /opt/homebrew/bin/node $DARKHAN_PATH/server/server.js &
```

### Start (development — as yourself, with dev mode)

```bash
cd ~/darkhan/server
DARKHAN_DEV_MODE=true node server.js
```

Development mode disables integrity baseline checks so code changes don't trigger lockdown. All other security remains active (injection detection, identity enforcement, credential isolation).

**WARNING:** Never use `DARKHAN_DEV_MODE=true` in production or in a launchd plist. It silently disables ALL integrity monitoring. If the database has users and dev mode is active, the integrity service logs a warning at startup.

### Start with deploy mode (after code changes in production)

```bash
cd ~/darkhan/server
node server.js --deploy
```

Deploy mode is a human-authenticated baseline reset for production. It:
1. Verifies you are in an interactive terminal (refuses Claude Code and relay sessions)
2. Prompts for your lockdown PIN (verified via bcrypt against secrets.db)
3. Resets the integrity baseline to match the current file state
4. Saves a new HMAC anchor
5. Starts the server normally

Use this after deploying code changes to production. Three failed PIN attempts exit the process.

### Stop

```bash
sudo kill $(pgrep -f "node server/server.js")
```

### Restart (production)

```bash
sudo kill $(pgrep -f "node server/server.js")
sleep 1
sudo -u _darkhan /opt/homebrew/bin/node $DARKHAN_PATH/server/server.js &
```

### Check status

```bash
# Is it running?
pgrep -fl "node.*server.js"

# Is it responding?
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/

# Full system status (no auth required)
cd ~/darkhan/server && node break-glass.js status
```

---

## After Code Changes

This is the most common operation during active development. When you edit code files and need to restart Darkhan:

### Option A: Deploy mode (recommended — resets baseline with PIN authentication)

```bash
sudo kill $(pgrep -f "node server/server.js") 2>/dev/null
cd ~/darkhan/server
sudo -u _darkhan /opt/homebrew/bin/node server.js --deploy
```

This prompts for your lockdown PIN, resets the integrity baseline to match your code changes, and starts the server. No break-glass needed.

### Option B: Development mode (for active building sessions only)

```bash
# Start in dev mode — no integrity checks, no lockdown on code changes
sudo kill $(pgrep -f "node server/server.js") 2>/dev/null
cd ~/darkhan
DARKHAN_DEV_MODE=true sudo -u _darkhan /opt/homebrew/bin/node server/server.js &
```

**WARNING:** Dev mode disables ALL integrity monitoring. Never leave it enabled when you stop building. Switch to deploy mode or production mode when done.

### Option C: Production mode (manual baseline reset)

```bash
# 1. Reset the baseline to include your changes (requires Terminal + PIN)
cd ~/darkhan/server
sudo -u _darkhan node break-glass.js reset-baseline

# 2. Restart
sudo kill $(pgrep -f "node server/server.js")
sudo -u _darkhan /opt/homebrew/bin/node $DARKHAN_PATH/server/server.js &
```

### Option D: Git commit + production restart

```bash
# 1. Commit your changes
cd ~/darkhan && git add -A && git commit -m "description"

# 2. Reset baseline (Terminal + PIN)
cd server && sudo -u _darkhan node break-glass.js reset-baseline

# 3. Restart in production mode
sudo kill $(pgrep -f "node server/server.js")
sudo -u _darkhan /opt/homebrew/bin/node $DARKHAN_PATH/server/server.js &

# 4. Push to GitHub
cd ~/darkhan && git push
```

---

## Break-Glass Recovery

Break-glass is the emergency admin tool. It operates directly on the database, outside Darkhan's security stack.

**Requirements:**
- Must be run from a real terminal (not from Claude Code or scripts)
- Destructive commands require your lockdown PIN
- Must run as `_darkhan` user (owns the database files)

### Commands

```bash
cd ~/darkhan/server

# Check system status (no PIN required)
sudo -u _darkhan node break-glass.js status

# Reset a forgotten password (PIN required)
sudo -u _darkhan node break-glass.js reset-password

# Lift a stuck lockdown (PIN required)
sudo -u _darkhan node break-glass.js lift-lockdown

# Reset integrity baseline after code changes (PIN required)
sudo -u _darkhan node break-glass.js reset-baseline
```

### When to use break-glass

| Situation | Command |
|-----------|---------|
| Can't log into web UI | `reset-password` |
| Lockdown won't lift via web UI | `lift-lockdown` then restart |
| Changed code, getting lockdown on restart | `reset-baseline` then restart |
| Need to check system state without web UI | `status` |
| System in unknown state after crash | `status` first, then fix as needed |

### Security notes

- Claude Code CANNOT run break-glass destructive commands (no TTY)
- AI agents CANNOT run break-glass (no TTY, no PIN)
- Every break-glass action is logged to the immutable activity trail
- Break-glass reads `secrets.db` to verify your PIN — it must run as `_darkhan`

---

## Lockdown Recovery

If Darkhan enters lockdown, follow this sequence:

### Step 1: Identify the cause

Check the web UI Settings page for the lockdown reason. Or:

```bash
cd ~/darkhan/server && sudo -u _darkhan node break-glass.js status
```

### Step 2: Fix the cause

| Cause | Fix |
|-------|-----|
| Integrity violation (code changed) | Normal during development. Use deploy mode (`node server.js --deploy`) or reset baseline via break-glass. |
| Injection detected | Review the flagged message in chan_alerts. May be a false positive. |
| Brute-force login attempt | Wait for cooldown or restart server. |
| Quarantine overflow | Review quarantine queue in Settings. Approve safe messages, reject threats. |
| Behavioral anomaly | Check baselines: `curl http://localhost:3001/api/baselines -H "X-API-Key: KEY"` |
| Unknown/stuck | Lift lockdown via break-glass. |

### Step 3: Unlock

**Via web UI (preferred):** Settings > Unlock Lockdown > Enter PIN

**Via break-glass (if web UI is unusable):**
```bash
cd ~/darkhan/server
sudo -u _darkhan node break-glass.js lift-lockdown
# Then restart:
sudo kill $(pgrep -f "node server/server.js")
sudo -u _darkhan /opt/homebrew/bin/node $DARKHAN_PATH/server/server.js &
```

---

## Adding a New Agent

1. Add the agent to `darkhan.config.json`:
```json
{
  "id": "agent_newhire",
  "name": "NewHire",
  "type": "agent",
  "role": "agent",
  "model": { "provider": "ollama", "model": "qwen2.5:14b", "mode": "worker" },
  "worker": "newhire.worker.js",
  "rateLimits": { "requestsPerDay": 500, "requestsPerMinute": 5 },
  "channels": ["chan_command", "chan_alerts"],
  "permissions": { "fsWrite": ["project/output/"], "shell": "restricted" }
}
```

2. Create the worker file at `server/workers/newhire.worker.js` (see WORKER-CONTRACT.md)

3. Re-seed to create the user and API key:
```bash
cd ~/darkhan/server && sudo -u _darkhan node db/seed.js
```

4. Save the printed API key — you'll need it if this agent runs on a remote node

5. Reset baseline and restart:
```bash
sudo -u _darkhan node break-glass.js reset-baseline
sudo kill $(pgrep -f "node server/server.js")
sudo -u _darkhan /opt/homebrew/bin/node $DARKHAN_PATH/server/server.js &
```

---

## Connecting a Second Instance (Federation)

### Current Setup (manual federation)

Two Darkhan instances connect via the FederatedWorkerRuntime. One is the **hub** (runs the database and web UI), the other runs **remote workers** that post back to the hub via HTTP API.

**On the hub (your machine):**
- Darkhan is running on port 3001
- Tailscale IP is accessible from the remote machine
- API keys for remote agents are generated by `seed.js`

**On the remote machine:**
1. Clone the repo: `git clone <repo-url> darkhan`
2. `cd darkhan/server && npm install`
3. Create `.env` with `REMOTE_HOST`, API keys, and LLM keys
4. Run: `node remote-runner.js`

The remote workers will post messages, complete tasks, and send heartbeats to your hub. They appear as team members in your web UI.

### With mTLS (recommended for non-Tailscale networks)

1. Generate certificates on the hub:
```bash
bash server/scripts/generate-certs.sh ~/.darkhan-certs hub-node
bash server/scripts/generate-certs.sh ~/.darkhan-certs remote-node
```

2. Copy `ca.crt` and `remote-node.crt` + `remote-node.key` to the remote machine

3. Enable TLS in both configs: `"tls": { "enabled": true, "ca": "...", "cert": "...", "key": "..." }`

4. Switch `REMOTE_HOST` to `https://`

### Future: Peer-to-Peer Federation

A future release will connect independent Darkhan instances as peers (not hub/spoke). Each instance keeps its own database, users, and agents. Planned additions:
- Ed25519 signed message envelopes
- Cross-instance CRISPR spacer propagation
- Channel-level encryption
- Federated verification (compare chain heads)

---

## Backup and Restore

### Backup

```bash
# Database backup (must run as _darkhan to read the files)
sudo -u _darkhan cp ~/darkhan/server/db/darkhan.db ~/darkhan-backups/darkhan_$(date +%Y%m%d).db
sudo -u _darkhan cp ~/darkhan/server/db/secrets.db ~/darkhan-backups/secrets_$(date +%Y%m%d).db

# Code backup (git)
cd ~/darkhan && git push
```

### Restore

```bash
# Stop Darkhan
sudo kill $(pgrep -f "node server/server.js")

# Restore database
sudo -u _darkhan cp ~/darkhan-backups/darkhan_YYYYMMDD.db ~/darkhan/server/db/darkhan.db
sudo -u _darkhan cp ~/darkhan-backups/secrets_YYYYMMDD.db ~/darkhan/server/db/secrets.db

# Reset baseline for restored state
cd ~/darkhan/server && sudo -u _darkhan node break-glass.js reset-baseline

# Restart
sudo -u _darkhan /opt/homebrew/bin/node $DARKHAN_PATH/server/server.js &
```

### Full reset (nuclear option)

```bash
sudo kill $(pgrep -f "node server/server.js")
sudo -u _darkhan rm ~/darkhan/server/db/darkhan.db ~/darkhan/server/db/secrets.db
cd ~/darkhan/server && sudo -u _darkhan node db/seed.js
sudo -u _darkhan node break-glass.js reset-baseline
sudo -u _darkhan /opt/homebrew/bin/node $DARKHAN_PATH/server/server.js &
```

You will lose all messages, activity log, and credentials. You will keep all code and configuration.

---

## Certificate Management

### Renew node certificates (annually)

```bash
# Regenerate cert for a node (reuses existing CA)
bash server/scripts/generate-certs.sh ~/.darkhan-certs hub-node

# Copy new cert to the node if remote
scp ~/.darkhan-certs/remote-node.crt ~/.darkhan-certs/remote-node.key user@remote:~/.darkhan-certs/

# Restart both nodes
```

### Rotate CA (emergency — all certs become invalid)

```bash
# Delete old CA and regenerate everything
rm ~/.darkhan-certs/ca.*
bash server/scripts/generate-certs.sh ~/.darkhan-certs hub-node
bash server/scripts/generate-certs.sh ~/.darkhan-certs remote-node

# Distribute new ca.crt and node certs to all machines
# Restart all nodes
```

---

## Process Isolation

### Enabling forked worker mode

In `darkhan.config.json`, set:

```json
{
  "sandbox": {
    "processIsolation": true
  }
}
```

Then restart Darkhan. Workers will run as isolated child processes. Check startup logs for confirmation messages like "Worker agent_assistant started in forked process."

**Note:** In development mode (`NODE_ENV=development`), workers always run in-process regardless of this setting.

### Troubleshooting forked workers

| Problem | Solution |
|---------|----------|
| Worker not responding after fork | Check for errors in the startup log. The child process may have crashed during initialization. |
| IPC errors in logs | The parent-child communication channel failed. Restart Darkhan. |
| Worker takes >5s to shut down | The graceful shutdown timeout was exceeded. The child process was force-killed. Check for long-running tasks that need shorter timeouts. |

### Disabling a single agent

To stop a specific agent without full lockdown:

```bash
# Disable (stops cron jobs, keeps the worker loaded)
curl -X POST http://localhost:3001/api/workers/agent_assistant/disable -H "X-API-Key: ADMIN_KEY"

# Re-enable
curl -X POST http://localhost:3001/api/workers/agent_assistant/enable -H "X-API-Key: ADMIN_KEY"
```

Admin API key required. Disabled workers stop running cron tasks but remain loaded and can be re-enabled without a restart.

### Changing execution tier

Execution tiers control how much autonomy agents have when processing tool calls. Change via the web UI (Settings) or API:

```bash
# Check current tier
curl -s http://localhost:3001/api/auth/execution-tier -H "Cookie: connect.sid=YOUR_SESSION"

# Set tier (requires session auth — human users only)
curl -X POST http://localhost:3001/api/auth/execution-tier \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=YOUR_SESSION" \
  -H "X-Darkhan-Client: true" \
  -d '{"tier": "operational"}'
```

Valid tiers: `supervised` (default), `operational`, `autonomous`. Changes take effect on the next Claude session — existing sessions continue with their original tier. To force a session refresh, restart the server.

All tier changes are logged to the immutable activity trail (`execution_tier_changed`). Auto-approved tool calls under elevated tiers are logged as `tier_auto_approved`. Security-boundary prompts under autonomous tier are logged as `security_boundary_prompt`.

---

## Maintenance

### Automatic (runs on every server start)

Darkhan runs a maintenance pass on every startup:

1. **PID file check** -- detects if the previous instance crashed without graceful shutdown
2. **Orphan process scan** -- finds and kills worker child processes orphaned by a crash (PPID=1)
3. **Stale heartbeat purge** -- marks agents not seen in 24+ hours as `down`
4. **Expired session cleanup** -- deletes sessions older than 7 days

### Daily (automatic schedule)

A daily maintenance cycle runs automatically (plus 1 hour after startup):

- All startup checks above
- **Activity log trim** -- deletes entries older than 30 days
- **Database VACUUM** -- reclaims disk space from deleted rows
- **Dead worker detection** -- logs any workers in `dead` state
- **Temp file cleanup** -- removes stale sandbox files from `/tmp/darkhan-sandbox/`

### Manual trigger

Admins can trigger maintenance on demand:

```bash
# Trigger maintenance
curl -X POST http://localhost:3001/api/health/maintenance -H "X-API-Key: ADMIN_KEY"

# Check last maintenance run
curl -s http://localhost:3001/api/health/maintenance -H "X-API-Key: YOUR_KEY"
```

### After a crash or freeze

If Darkhan or an external tool (like Claude Code) freezes or crashes:

1. Kill the stuck process: `kill $(pgrep -f "node server/server.js")`
2. Restart Darkhan -- the startup maintenance pass will clean up orphan processes automatically
3. Check for stale background processes: `ps aux | grep darkhan | grep -v grep`

---

## Pre-Commit Hook and Secret Scanner

### How it works

Two layers of commit-time protection:

**Layer 1: Pre-commit hook** (`scripts/pre-commit-hook.sh`) blocks:
- Source map files (`.map`) -- prevents source code leaks
- Database files (`.db`, `.db-wal`, `.db-shm`)
- Environment files (`.env`, excluding `.env.example`)
- Private keys and certificates (`.key`, `.pem`, `.csr`, `.p12`)
- Hardcoded API key patterns in staged code
- Large files (>5MB) -- build artifact warning
- Live worker files (team-specific configs)

**Layer 2: Secret scanner** (`server/scripts/secret-scanner.js`) catches:
- API keys (AWS, Google, Anthropic, OpenAI, Azure, GitHub, Slack, Telegram, Darkhan)
- Private keys (RSA, EC, Ed25519 PEM blocks)
- JWTs (`eyJ...`)
- Database connection strings
- Hardcoded secret assignments (`secret = "..."`, `password = "..."`)

### Setup

Install the pre-commit hook:

```bash
cp scripts/pre-commit-hook.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

### Bypassing (emergency only)

If a commit is falsely blocked and you are certain the match is a false positive:

```bash
git commit --no-verify -m "your message"
```

Document why you bypassed the scanner in the commit message.

### After a real secret exposure

If a secret was committed before the scanner was installed:

1. Revoke the exposed credential immediately
2. Remove it from the code and move to `.env`
3. Force-push to remove the commit from history (or use `git filter-branch`)
4. Generate a new credential

---

## Model Verification

### Startup check

On every server start, `model-verifier.js` verifies Ollama model files against their manifest SHA-256 digests. This runs automatically -- no action needed.

Check startup logs for:
- `Model verification passed` -- all digests match
- `Model verification failed` -- a model file does not match its manifest digest

### If verification fails

| Cause | Fix |
|-------|-----|
| Corrupted download | Re-pull the model: `ollama pull qwen2.5:14b` |
| Tampered model file | Delete and re-pull: `ollama rm qwen2.5:14b && ollama pull qwen2.5:14b` |
| Ollama not running | Start Ollama: `brew services start ollama` |

### Manual verification

```bash
cd ~/darkhan/server && node model-verifier.js
```

This runs the same check outside of the server startup sequence.

---

## Common Issues

| Problem | Solution |
|---------|----------|
| Lockdown on every restart | You're in production mode with stale baseline. Use dev mode (`NODE_ENV=development`) or reset baseline before restarting. |
| "Permission denied" on db files | Server must run as `_darkhan`. Use `sudo -u _darkhan`. |
| break-glass says "ACCESS DENIED" | You're running it from Claude Code. Open a real Terminal window. |
| break-glass says "SQLITE_CANTOPEN" | Run from the `server/` directory: `cd ~/darkhan/server && sudo -u _darkhan node break-glass.js ...` |
| Agent messages return 403 | System is in lockdown. Check Settings or run `break-glass.js status`. |
| Workers not loading | Check startup log for "LOCKDOWN" or "Integrity violation". |
| Can't push to GitHub | `git` can't read `server/db/` (owned by `_darkhan`). This is expected — db files are in `.gitignore`. |
| Node path wrong in launchd | Verify with `which node` — Apple Silicon uses `/opt/homebrew/bin/node`. |
| Remote workers can't connect | Check Tailscale connectivity. Verify API keys match. Check REMOTE_HOST URL. |
| Orphan processes after crash | Restart Darkhan — the maintenance service detects and cleans orphan workers automatically. Or manually: `ps aux \| grep worker-process \| grep -v grep` to find them. |
| Stale heartbeats showing green | Maintenance purges agents not seen in 24h. Trigger manually: `curl -X POST http://localhost:3001/api/health/maintenance -H "X-API-Key: ADMIN_KEY"` |
| npm audit fails in CI | Run `npm audit` locally, fix or document the vulnerability. `npm audit fix` resolves most issues. For transitive deps, consider replacing the parent package. |
| Pre-commit hook blocks commit | Review the blocked files. If false positive: `git commit --no-verify`. If real: fix the issue before committing. |
