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
8. [Step 7: Auto-Start with launchd](#step-7-auto-start-with-launchd)
9. [Step 8: Write Your First Worker](#step-8-write-your-first-worker)
10. [Step 9: Federated Setup (Multi-Node)](#step-9-federated-setup-multi-node)
11. [Verification Checklist](#verification-checklist)
12. [Troubleshooting](#troubleshooting)

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
cd darkhan/server

# Install dependencies
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
| `SESSION_SECRET` | Yes | The random string you just generated |
| `PORT` | No | Server port (default: 3001) |
| `OLLAMA_MODEL` | No | Your Ollama model name (default: qwen2.5:14b) |
| `GOOGLE_API_KEY` | If using Gemini agents | Your Google AI Studio API key |
| `ANTHROPIC_API_KEY` | If using security escalation | Your Anthropic API key |

See `.env.example` for the full list of supported variables with comments.

**Security note:** The `.env` file contains secrets. It is listed in `.gitignore` and must never be committed to version control.

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
  ]
}
```

**Key concepts:**
- `type: "human"` members log in via the web UI with a password
- `type: "agent"` members authenticate via API key and run as workers
- `role: "admin"` grants access to Settings (password change, lockdown management)
- `rateLimits` with `0` means unlimited (appropriate for local Ollama models)
- `permissions.shell` controls what shell commands the agent can run: `full`, `restricted`, or `none`

---

## Step 4: Initialize the Database

```bash
node db/seed.js
```

This creates the SQLite database (`db/darkhan.db`) and seeds it with:
- User accounts for every team member in your config
- Default channels
- API keys for agent accounts

**Save the API keys that are printed to the console.** You will need them for:
- Agent scripts that post to Darkhan from outside
- Remote worker configuration (if doing federated setup)

If you ever need to reset the database, delete `db/darkhan.db` and re-run `node db/seed.js`.

---

## Step 5: Start Darkhan

```bash
node server.js
```

You should see output confirming:
- Server started on the configured port
- Workers loaded
- Database connected
- Integrity baseline established

---

## Step 6: First Login & Security Setup

1. Open `http://localhost:3001` in your browser
2. Log in with your username (lowercase, from config) and the default password `changeme`
3. **Immediately do the following:**
   - Open the **Settings** view (gear icon, admin users only)
   - **Change your password** to something strong
   - **Set a lockdown PIN** -- this is a second factor required to unlock the system after a lockdown event. Choose something you will remember but that an agent cannot guess

**Why the lockdown PIN matters:** If a security event triggers automatic lockdown, agents cannot unlock the system. You (the human admin) must authenticate via the web UI and provide the PIN to restore agent operations. This prevents a compromised agent from social-engineering its way out of lockdown.

---

## Step 7: Auto-Start with launchd

For production use, configure launchd so Darkhan starts automatically on boot and restarts on crash.

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

- [ ] `http://localhost:3001` loads the login page
- [ ] Login works with your credentials
- [ ] You changed the default password via Settings
- [ ] You set a lockdown PIN via Settings
- [ ] Messages appear in the #command channel
- [ ] Workers show as loaded: `curl -s http://localhost:3001/api/workers -H "X-API-Key: YOUR_KEY"`
- [ ] Agent status dots show green in the Health view
- [ ] Ollama responds: `curl -s http://localhost:11434/api/tags` shows your model
- [ ] Post "comms check" in #command -- all workers respond
- [ ] (If federated) Remote workers respond to comms check

---

## Troubleshooting

### Server Will Not Start

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
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

### Security / Lockdown

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| All agent messages return 403 | System is in lockdown | Check Settings view in web UI for lockdown status and reason. Unlock with admin auth + PIN |
| Lockdown triggered unexpectedly | Auto-threshold exceeded | Check activity log for the trigger: `curl -s "http://localhost:3001/api/activity?action=lockdown_activated&limit=5" -H "X-API-Key: YOUR_KEY"` |
| Cannot unlock | PIN not set or forgotten | Contact the admin who set the PIN. If you are the only admin, you will need to re-seed the database |

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
