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
9. [Common Issues](#common-issues)

---

## Starting and Stopping

### Start (production — as service user)

```bash
sudo -u _darkhan /opt/homebrew/bin/node $DARKHAN_PATH/server/server.js &
```

### Start (development — as yourself, with dev mode)

```bash
cd ~/darkhan/server
NODE_ENV=development node server.js
```

Development mode disables integrity baseline checks so code changes don't trigger lockdown. All other security remains active (injection detection, identity enforcement, credential isolation).

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

### Option A: Development mode (recommended during active building)

```bash
# Start in dev mode — no integrity checks, no lockdown on code changes
sudo kill $(pgrep -f "node server/server.js") 2>/dev/null
cd ~/darkhan
NODE_ENV=development sudo -u _darkhan /opt/homebrew/bin/node server/server.js &
```

### Option B: Production mode (use when you're done building for the day)

```bash
# 1. Reset the baseline to include your changes (requires Terminal + PIN)
cd ~/darkhan/server
sudo -u _darkhan node break-glass.js reset-baseline

# 2. Restart
sudo kill $(pgrep -f "node server/server.js")
sudo -u _darkhan /opt/homebrew/bin/node $DARKHAN_PATH/server/server.js &
```

### Option C: Git commit + production restart

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
| Integrity violation (code changed) | Normal during development. Reset baseline. |
| Injection detected | Review the flagged message in chan_alerts. May be a false positive. |
| Brute-force login attempt | Wait for cooldown or restart server. |
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

### Before Mokume (current — manual federation)

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

### After Mokume (future — enterprise federation)

Mokume connects independent Darkhan instances as peers (not hub/spoke). Each instance has its own database, users, and agents. Mokume adds:
- Ed25519 signed message envelopes
- Cross-instance CRISPR spacer propagation
- Channel-level encryption
- Federated verification (compare chain heads)

This is scheduled for the week of April 12.

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
