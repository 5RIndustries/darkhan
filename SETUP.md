# Darkhan -- Setup & Onboarding Guide

> This guide walks a new team member through deploying Darkhan on their own machine.
> Estimated time: 30-45 minutes for a single node, 60 minutes for a federated setup.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Step 1: Install](#step-1-install)
3. [Step 2: Configure Environment](#step-2-configure-environment)
4. [Step 3: Configure Your Team](#step-3-configure-your-team)
5. [Step 4: Initialize the Database](#step-4-initialize-the-database)
6. [Step 5: Start Darkhan](#step-5-start-darkhan)
7. [Step 6: First Login & Security Setup](#step-6-first-login--security-setup)
8. [Step 6.5: Security Hardening (Recommended)](#step-65-security-hardening-recommended)
9. [Step 7: Auto-Start with launchd](#step-7-auto-start-with-launchd)
10. [Step 8: Write Your First Worker](#step-8-write-your-first-worker)
11. [Step 9: Federated Setup (Multi-Node)](#step-9-federated-setup-multi-node)
12. [Verification Checklist](#verification-checklist)
13. [Troubleshooting](#troubleshooting)

---

## Prerequisites

**Required:**
- **macOS** (Apple Silicon recommended) or Linux
- **Node.js 20+** -- `brew install node` or [nodejs.org](https://nodejs.org)
- **Ollama** -- `brew install ollama` then `brew services start ollama`
- **Git** -- for cloning the repo

**Optional (recommended for full capability):**
- **Google API key** -- for Gemini-powered agents. Get one at [aistudio.google.com](https://aistudio.google.com)
- **Anthropic API key** -- for security escalation to Claude. Get one at [console.anthropic.com](https://console.anthropic.com)
- **Tailscale** -- for multi-node federation. Get it at [tailscale.com](https://tailscale.com)

**Hardware guidance:**
- 16GB RAM minimum (runs Qwen 2.5 14B via Ollama comfortably)
- 8GB RAM: use a smaller model (`qwen2.5:7b` or `qwen2.5:3b`)
- 24GB+ RAM recommended if running multiple cloud-backed agents alongside local LLM

---

## Step 1: Install

```bash
# Clone the repo
git clone <repo-url> darkhan
cd darkhan

# Install the secret scanner pre-commit hook (blocks accidental credential commits).
# This is automatic -- it configures git to use the .githooks/ directory, which
# contains a pre-commit hook that runs secret-scanner.js on every staged diff.
# It catches API keys, tokens, private keys, JWTs, and connection strings.
git config core.hooksPath .githooks

# Install dependencies
cd server
npm install

# Pull the local LLM
ollama pull qwen2.5:14b

# If your machine has <16GB RAM, use a smaller model:
# ollama pull qwen2.5:7b
```

Verify Ollama is running and the model is available:

```bash
ollama list
# Should show qwen2.5:14b (or your chosen model)
```

---

## Step 2: Configure Environment

```bash
# Copy the example environment file
cp .env.example .env

# Generate a session secret (paste the output into .env)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Edit `.env` with your values:

| Variable | Required | What to Set |
|----------|----------|-------------|
| `SESSION_SECRET` | **Yes** | The random string you just generated. **Server refuses to start without it.** Also used to derive HMAC keys for lockdown state signing. |
| `PORT` | No | Server port (default: 3001) |
| `OLLAMA_MODEL` | No | Your Ollama model name (default: qwen2.5:14b) |
| `GOOGLE_API_KEY` | If using Gemini agents | Your Google AI Studio API key |
| `ANTHROPIC_API_KEY` | If using security escalation | Your Anthropic API key |

See `.env.example` for the full list of supported variables with comments.

**Security note:** The `.env` file contains secrets. It is listed in `.gitignore` and must never be committed to version control. `SESSION_SECRET` is not just for sessions -- it also derives the HMAC key that signs lockdown state in the database. If you change it, any persisted lockdown state will fail signature verification and the system will fail closed (lock down).

---

## Step 3: Configure Your Team

Edit `darkhan.config.json` to define your instance and team members. Here is a minimal example:

```json
{
  "instance": {
    "name": "Your Team Name",
    "brandName": "Darkhan",
    "port": 3001,
    "timezone": "America/New_York"
  },
  "team": {
    "members": [
      {
        "id": "user_yourname",
        "name": "Your Name",
        "type": "human",
        "role": "admin",
        "channels": ["chan_command", "chan_alerts"]
      },
      {
        "id": "agent_assistant",
        "name": "Assistant",
        "type": "agent",
        "role": "agent",
        "model": {
          "provider": "ollama",
          "model": "qwen2.5:14b",
          "mode": "worker"
        },
        "worker": "chief.worker.js",
        "rateLimits": {
          "requestsPerDay": 0,
          "requestsPerMinute": 0
        },
        "permissions": {
          "shell": "restricted"
        },
        "channels": ["chan_command", "chan_alerts"]
      }
    ]
  },
  "channels": [
    { "id": "chan_command", "name": "Command", "description": "Primary channel" },
    { "id": "chan_alerts", "name": "Alerts", "description": "System alerts" }
  ],
  "sandbox": {
    "processIsolation": true
  }
}
```

**Key concepts:**
- `type: "human"` members log in via the web UI with a password
- `type: "agent"` members authenticate via API key and run as workers
- `role: "admin"` grants access to Settings (password change, lockdown management)
- `rateLimits` with `0` means unlimited (appropriate for local Ollama models)
- `permissions.shell` controls what shell commands the agent can run: `full`, `restricted`, or `none`
- `sandbox.processIsolation` runs each worker as an isolated child process via `fork()` (recommended for production; automatically disabled in development mode for faster iteration)

---

## Step 4: Initialize the Database

```bash
node db/seed.js
```

This creates two SQLite databases and seeds them:

| Database | Contains | Accessed by |
|----------|----------|-------------|
| `db/darkhan.db` | Users, channels, messages, tasks, activity log | Server + workers |
| `db/secrets.db` | Password hashes, API keys, lockdown PIN | Server + auth middleware **only** |

The seed process:
- Creates user accounts for every team member in your config
- Seeds default channels
- Generates API keys for agent accounts (stored in secrets.db)
- Sets permissions on secrets.db to 600 (owner-only read/write)

**Save the API keys that are printed to the console.** You will need them for:
- Agent scripts that post to Darkhan from outside
- Remote worker configuration (if doing federated setup)

If you ever need to reset the database, delete both `db/darkhan.db` and `db/secrets.db`, then re-run `node db/seed.js`.

### Upgrading from Darkhan v1 (secrets.db Migration)

If you are upgrading an existing Darkhan v1 install that has credentials in `darkhan.db`:

1. Stop the Darkhan server
2. Run `node db/seed.js` -- this will create `secrets.db` and populate it with credentials
3. Start the server -- it will apply the secrets schema automatically
4. Verify login works. If not, re-seed: delete both `.db` files and run `node db/seed.js` again

After migration, password hashes and API keys exist only in `secrets.db`. The `users` table in `darkhan.db` no longer contains `password_hash` or `api_key` columns.

---

## Step 5: Start Darkhan

```bash
node server.js
```

You should see output confirming:
- Server started on the configured port
- Connected to database (darkhan.db)
- Connected to secrets database (secrets.db)
- Secrets schema applied, permissions set to 600
- **Model verification passed** -- Ollama model file SHA-256 digests checked against manifest (first startup may take a moment for large models)
- Workers loaded
- Integrity baseline established

**If the server refuses to start** with a `SESSION_SECRET` error, go back to Step 2 and ensure `SESSION_SECRET` is set in your `.env` file. There is no fallback -- this is a hard requirement.

---

## Step 6: First Login & Security Setup

1. Open `http://localhost:3001` in your browser
2. Log in with your username (lowercase, from config) and the default password `changeme`
3. **Immediately do the following (both are required):**
   - Open the **Settings** view (gear icon, admin users only)
   - **Change your password** to something strong (minimum 8 characters)
   - **Set a lockdown PIN** -- this is a second factor required to unlock the system after a lockdown event. Minimum 4 characters. Choose something you will remember but that an agent cannot guess.

**Both steps are critical.** If you skip setting the lockdown PIN and the system enters lockdown (auto-triggered or manual), you will not be able to unlock it. The system fails closed: no PIN configured means no unlock allowed. You would need to re-seed the database to recover.

**Why the lockdown PIN matters:** If a security event triggers automatic lockdown, agents cannot unlock the system. You (the human admin) must authenticate via the web UI and provide the PIN to restore agent operations. The PIN hash is stored in `secrets.db` (not the main database), so even a worker with full database access to `darkhan.db` cannot read it.

---

## Step 6.5: Security Hardening (Recommended)

These steps are optional for development but **strongly recommended for production deployments**.

### Layer 2: Service User Privilege Separation

Create a dedicated `_darkhan` service user that owns sensitive files. The server process runs as this user, separating it from your developer account.

```bash
cd server
sudo scripts/setup-service-user.sh
```

This script:
- Creates the `_darkhan` system user (no home directory, no login shell)
- Changes ownership of `db/`, `.env`, integrity baseline, and TLS certificates to `_darkhan`
- Sets file permissions so only `_darkhan` can read secrets
- Application code remains owned by your developer account

**Why this matters:** If an attacker compromises your developer session, they cannot directly read the database or `.env` file because those are owned by a different user.

### Layer 3: macOS Keychain Integration

Move critical secrets from `.env` into the macOS Keychain for hardware-backed encryption.

```bash
cd server
scripts/setup-keychain.sh
```

This script:
- Prompts you for each secret (SESSION_SECRET, API keys)
- Stores them in the macOS Keychain under the `com.darkhan.server` service
- Darkhan reads from Keychain at startup, falling back to `.env` if not provisioned

**Why this matters:** Secrets in `.env` are plaintext on disk. Secrets in Keychain are encrypted by the Secure Enclave and require user authentication to access.

### Verify hardening

After running both scripts:

```bash
# Check file ownership
ls -la db/ .env

# Verify _darkhan user exists
id _darkhan

# Check Keychain entries (should list com.darkhan.server items)
security find-generic-password -s com.darkhan.server 2>&1 | head -5
```

---

## Step 7: Auto-Start with launchd

For production use, configure launchd so Darkhan starts automatically on boot and restarts on crash.

**If you completed Step 6.5 (service user),** use the provided plist template that runs as `_darkhan`:

```bash
sudo cp server/scripts/com.darkhan.server.plist /Library/LaunchDaemons/
sudo launchctl load /Library/LaunchDaemons/com.darkhan.server.plist
```

**If you skipped Step 6.5,** create a user-level plist:

Create the plist file:

```bash
cat > ~/Library/LaunchAgents/com.darkhan.server.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.darkhan.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>DARKHAN_PATH/server/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>DARKHAN_PATH/server</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>YOUR_HOME</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>YOUR_HOME/Library/Logs/darkhan-server.log</string>
    <key>StandardErrorPath</key>
    <string>YOUR_HOME/Library/Logs/darkhan-server.log</string>
</dict>
</plist>
PLIST
```

Replace the placeholders:
- `DARKHAN_PATH` -- absolute path to your darkhan directory (e.g., `~/darkhan`)
- `YOUR_HOME` -- your home directory (e.g., `/Users/tino`)

Then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.darkhan.server.plist
```

**Verify it is running:**

```bash
launchctl list | grep darkhan
# Should show a PID (first column) and exit status 0
```

**Important for launchd:** The `PATH` in `EnvironmentVariables` must include the directory where `node` is installed. launchd does not inherit your shell's PATH. If you use tools like `bun`, add its path here too (e.g., `~/.bun/bin`).

---

## Step 8: Write Your First Worker

Create a worker file at `server/workers/myagent.worker.js`:

```javascript
module.exports = {
  id: 'agent_assistant',  // Must match config
  name: 'Assistant',

  async onLoad({ darkhan, log }) {
    log.info('Assistant online');
    await darkhan.post('chan_command', 'Assistant online and ready.');
  },

  tasks: {
    daily_summary: {
      schedule: '0 9 * * *',  // 9 AM daily
      timeout: 120000,         // 2 min max

      async run({ llm, darkhan, tools, log }) {
        const result = await llm.complete({
          messages: [{ role: 'user', content: 'What should I focus on today?' }],
          options: { temperature: 0.3 },
        });
        await darkhan.post('chan_command', result.response);
      }
    },

    heartbeat: {
      schedule: '*/5 * * * *',  // Every 5 minutes
      timeout: 5000,
      async run({ darkhan }) { await darkhan.ping('active'); }
    }
  },

  listeners: {
    comms_check: {
      patterns: [/^comms?\s*check$/i],
      timeout: 15000,
      async run({ darkhan }, { channelId }) {
        await darkhan.post(channelId, 'Assistant standing by.');
      }
    }
  }
};
```

Make sure the agent is in `darkhan.config.json` with `"worker": "myagent.worker.js"`, then restart Darkhan.

For the complete worker specification, see [WORKER-CONTRACT.md](WORKER-CONTRACT.md).

---

## Step 9: Federated Setup (Multi-Node)

If you want to run workers on a second machine that reports back to your main Darkhan instance:

### On the hub node (main server)

1. Ensure Darkhan is running and accessible on the network
2. Note the hub's Tailscale IP (e.g., `100.x.y.z`)
3. Note the API keys for the agents that will run remotely (printed during `node db/seed.js`)

### On the remote node

1. Clone the Darkhan repo and run `npm install` in `server/`
2. Create a `.env` file in `server/`:

```
REMOTE_HOST=http://TAILSCALE_IP:3001
CHIEF_API_KEY=dk_agent_...
LINDSEY_API_KEY=dk_agent_...
GOOGLE_API_KEY=your_google_key
OLLAMA_HOST=localhost
OLLAMA_PORT=11434
```

Replace `TAILSCALE_IP` with the hub's Tailscale IP. Replace the API key values with the actual keys from your hub's seed output.

3. Start the remote runner:

```bash
node remote-runner.js
```

4. Set up launchd for auto-start (same pattern as the hub, but pointing to `remote-runner.js` instead of `server.js`)

### Verify federation

Post "comms check" in the #command channel on the hub. Both local and remote workers should respond.

### Network requirements

- Both nodes must be on the same Tailscale network (or otherwise able to reach each other over HTTP)
- The hub must bind to `0.0.0.0` (default behavior) so it accepts connections from the Tailscale interface
- No public internet exposure is needed

---

## Verification Checklist

After setup, verify everything works:

### Core Functionality
- [ ] `http://localhost:3001` loads the login page
- [ ] Login works with your credentials
- [ ] You changed the default password via Settings (minimum 8 characters)
- [ ] You set a lockdown PIN via Settings (minimum 4 characters) -- **required before lockdown can be lifted**
- [ ] Messages appear in the #command channel
- [ ] Workers show as loaded: `curl -s http://localhost:3001/api/workers -H "X-API-Key: YOUR_KEY"`
- [ ] Agent status dots show green in the Health view
- [ ] Ollama responds: `curl -s http://localhost:11434/api/tags` shows your model
- [ ] Post "comms check" in #command -- all workers respond
- [ ] (If federated) Remote workers respond to comms check

### Ground Truth & Verification
- [ ] Ground truth seeded: `curl -s http://localhost:3001/api/ground-truth -H "X-API-Key: YOUR_KEY"` returns entries
- [ ] Ground truth brief: `curl -s http://localhost:3001/api/ground-truth/brief/text -H "X-API-Key: YOUR_KEY"` returns readable text
- [ ] Hash chain active: `curl -s http://localhost:3001/api/activity/chain-head -H "X-API-Key: YOUR_KEY"` returns a hash

### Security Hardening (if completed Step 6.5)
- [ ] Service user exists: `id _darkhan` succeeds
- [ ] Database owned by service user: `ls -la server/db/darkhan.db` shows `_darkhan`
- [ ] Keychain provisioned: `security find-generic-password -s com.darkhan.server` succeeds
- [ ] Break-glass works: `cd server && node break-glass.js status` shows server state
- [ ] Sandbox active: check server startup logs for "Sandbox service initialized"

---

## Troubleshooting

### Server Will Not Start

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "FATAL: SESSION_SECRET not set" | Missing env var | Add `SESSION_SECRET` to `.env`. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| "Cannot connect to database" | Database not initialized | Run `node db/seed.js` |
| "EADDRINUSE" / port in use | Another process on port 3001 | Change `PORT` in `.env`, or find the conflicting process with `lsof -i :3001` |
| "MODULE_NOT_FOUND" | Dependencies not installed | Run `npm install` in the `server/` directory |

### Workers Not Running

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Worker not in `/api/workers` output | ID mismatch | The `id` field in the worker file must exactly match the `id` in `darkhan.config.json` |
| Worker loads but tasks fail | LLM not available | Check Ollama (`ollama list`) or cloud API key in `.env` |
| Worker shows red in Health | Heartbeat not reaching server | Check logs for errors. If remote, verify network connectivity |

### Federation Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Remote workers not posting | Network issue | `ping TAILSCALE_IP` from the remote node |
| "401 Unauthorized" from remote | Bad API key | Verify the API key in remote `.env` matches what `seed.js` generated |
| Remote workers post but no listener responses | Polling not started | Check remote runner logs for startup confirmation |

### Ollama Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "connection refused" on 11434 | Ollama not running | `brew services start ollama` |
| Model not found | Not pulled | `ollama pull qwen2.5:14b` |
| Slow responses | Insufficient RAM | Use a smaller model: `ollama pull qwen2.5:7b` |

### Break-Glass Recovery

If you are completely locked out (forgot password, lockdown active, cannot access web UI), use the break-glass tool:

```bash
cd server
node break-glass.js status              # Check what state the system is in (no auth needed)
node break-glass.js reset-password      # Reset your password (requires lockdown PIN)
node break-glass.js lift-lockdown       # Lift lockdown (requires lockdown PIN)
node break-glass.js reset-baseline      # Reset integrity baseline (requires lockdown PIN)
```

**Requirements:**
- Must be run from an interactive terminal (TTY). Will not work from scripts, pipes, or SSH without TTY allocation.
- All commands except `status` require the lockdown PIN you set in Step 6.
- If you have lost your lockdown PIN, the only recovery path is to delete both database files and re-run `node db/seed.js`.

### Security / Lockdown

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| All agent messages return 403 | System is in lockdown | Check Settings view in web UI for lockdown status and reason. Unlock with admin auth + PIN. If web UI unavailable, use `node break-glass.js lift-lockdown` |
| Lockdown triggered unexpectedly | Auto-threshold exceeded | Check activity log for the trigger: `curl -s "http://localhost:3001/api/activity?action=lockdown_activated&limit=5" -H "X-API-Key: YOUR_KEY"` |
| Lockdown after modifying files | Integrity service detected changes | Expected during development. Restart the server to re-establish the integrity baseline |
| Cannot unlock -- "no PIN configured" | PIN not set in secrets.db | You must set a lockdown PIN via Settings before the system can be unlocked. If completely locked out, re-seed the database |
| Cannot unlock -- "signature mismatch" | Lockdown state tampered in DB | The HMAC signature on the lockdown state failed. System fails closed. Re-seed the database to reset |
| Cannot unlock -- PIN forgotten | Lost lockdown PIN | Contact the admin who set the PIN. If you are the only admin, delete both `.db` files and re-run `node db/seed.js` |
| API key auth stopped working | Upgrading from v1 without migration | API keys are now in secrets.db only. Re-run `node db/seed.js` to populate secrets.db |

### Logs

Logs are your primary diagnostic tool:

- **launchd-managed (production):** `~/Library/Logs/darkhan-server.log` (hub), `~/Library/Logs/darkhan-workers.log` (remote)
- **Manual runs:** Output goes to stdout
- **Activity log (API):** `GET /api/activity?limit=50` for recent system events

---

## Next Steps

- Read [README.md](README.md) for full architecture documentation
- Read [WORKER-CONTRACT.md](WORKER-CONTRACT.md) before writing workers
- Explore the web UI: check Health, Costs, and Vault views
- Set up push notifications (Pushover) for critical alerts by adding keys to `.env`
