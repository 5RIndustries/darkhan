# Darkhan -- Setup & Onboarding Guide

> This guide walks a new team member through deploying Darkhan on their own machine.
> Estimated time: 30-45 minutes for a single node, 60 minutes for a federated setup.

## Quick Start (Recommended)

### Option A: Automated install (macOS)

```bash
# Download and run the installer
curl -fsSL https://raw.githubusercontent.com/5RIndustries/darkhan/main/install.sh | bash
```

The installer asks before installing each prerequisite (Homebrew, Node.js, Ollama) -- skip any you already have. It auto-adds Homebrew to your `~/.zprofile` PATH (the number one friction point on fresh Macs). If the `git clone` fails for the private repo, it gives clear guidance on creating a GitHub Personal Access Token. If you already have a Darkhan clone, it pulls the latest instead of re-cloning.

After cloning, the installer runs the setup wizard automatically.

### Option B: Manual clone + setup wizard

```bash
git clone https://github.com/5RIndustries/darkhan.git && cd darkhan && node setup.js
```

### Option C: Import config from an existing Darkhan instance

If you're setting up a node to match an existing Darkhan (e.g., provisioning a second node for Mokume federation), you can export a portable config and import it:

```bash
# On the EXISTING Darkhan instance:
node scripts/export-config.js -o my-config.json --sign

# On the NEW machine:
git clone https://github.com/5RIndustries/darkhan.git && cd darkhan
node setup.js --from-config my-config.json
```

The import shows you exactly what the config contains — team members, channels, LLM providers, permissions — and asks for confirmation before applying anything. Fresh secrets (passwords, API keys, Ed25519 keypair) are always generated locally. Nothing sensitive transfers from the source instance.

### What the setup wizard does

The setup wizard (`setup.js`) is the primary setup path. It:

1. Checks prerequisites (Node.js, npm, Ollama)
2. Creates your `.env` with a generated `SESSION_SECRET`
3. Creates `darkhan.config.json` with your team name, admin username, and agent selection
4. Auto-detects your system timezone
5. Copies and configures the example worker file for your chosen agent
6. Cleans stale databases from any previous failed runs
7. Pulls the local LLM (Qwen 2.5 14B)
8. Seeds the database with default password `changeme`
9. Defaults to in-process workers (not forked) for simpler first-run experience
10. Starts the server and auto-opens your browser (macOS and Linux)
11. Prints clear "what happens next" instructions

**No password or PIN prompts during setup.** Both are handled on first login in the browser (see Step 6).

If you prefer to configure manually, follow the steps below.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Step 1: Install](#step-1-install)
3. [Step 2: Configure Environment](#step-2-configure-environment)
4. [Step 3: Configure Your Team](#step-3-configure-your-team)
5. [Step 4: Initialize the Database](#step-4-initialize-the-database)
6. [Step 5: Start Darkhan](#step-5-start-darkhan)
7. [Step 6: First Login & Security Setup](#step-6-first-login--security-setup)
8. [Step 7: Using the Integrated Terminal](#step-7-using-the-integrated-terminal)
9. [Step 8: Security Hardening (Recommended)](#step-8-security-hardening-recommended)
10. [Step 9: Auto-Start with launchd](#step-9-auto-start-with-launchd)
11. [Step 10: Write Your First Worker](#step-10-write-your-first-worker)
12. [Step 11: Federated Setup (Multi-Node)](#step-11-federated-setup-multi-node)
12. [Verification Checklist](#verification-checklist)
13. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Fresh Mac? Start here.

The easiest path is `install.sh` (see Quick Start above) -- it handles Homebrew, Node.js, and Ollama installation interactively, asking before each one and auto-configuring your PATH.

If you prefer to install prerequisites manually:

```bash
# Install Homebrew (macOS package manager)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# IMPORTANT: Add Homebrew to your PATH (install.sh does this automatically for .zprofile):
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

# Install Node.js and Ollama
brew install node ollama

# Start Ollama and pull the local LLM
brew services start ollama
ollama pull qwen2.5:14b
```

### Required
- **macOS** (Apple Silicon recommended) or Linux
- **Node.js 20+** -- `brew install node` or [nodejs.org](https://nodejs.org)
- **Ollama** -- `brew install ollama` then `brew services start ollama`
- **Git** -- included with macOS Xcode Command Line Tools (prompted automatically on first use), or `brew install git`

### No Homebrew / No sudo? (Manual Install)

If you cannot install Homebrew (e.g., no admin/sudo password on the machine), you can install Node.js and Ollama manually:

```bash
# Create a local install directory
mkdir -p ~/local/bin

# Node.js — download the official binary tarball (Apple Silicon example)
curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.xz | tar xJ -C ~/local/

# Ollama — install via the official script (installs to /usr/local/bin by default)
curl -fsSL https://ollama.com/install.sh | sh
# If it fails to write to /usr/local/bin, symlink manually:
ln -sf $(which ollama 2>/dev/null || echo /opt/homebrew/opt/ollama/bin/ollama) ~/local/bin/ollama

# Add both to your PATH (add to ~/.zprofile for persistence)
echo 'export PATH="$HOME/local/node-v22.14.0-darwin-arm64/bin:$HOME/local/bin:$PATH"' >> ~/.zprofile
source ~/.zprofile

# Verify
node --version   # Should show v22.x
ollama --version # Should show v0.x
```

### LAN Install (No GitHub Access Needed)

If the target machine is on the same network as an existing Darkhan install, you can rsync the repo instead of cloning from GitHub:

```bash
# From the machine that already has the repo:
rsync -az --exclude node_modules --exclude 'server/db/*.db*' \
  --exclude 'server/.env' --exclude 'server/darkhan.config.json' \
  --exclude 'server/workers/*.worker.js' \
  ~/darkhan/ user@TARGET_IP:~/darkhan/

# IMPORTANT: On the target machine, you MUST run npm install.
# Native modules (better-sqlite3) are compiled for a specific OS/arch
# and will not work if copied from a different machine.
cd ~/darkhan/server && npm install
```

Then continue from [Step 2](#step-2-configure-environment) to create your own `.env`, config, and database.

### Optional (recommended for full capability)
- **Claude Code CLI** -- for integrated Claude terminal sessions. Install: `curl -fsSL https://claude.ai/install.sh | bash`. Requires a Claude Pro/Max/Team plan or an Anthropic API key.
- **Google API key** -- for Gemini-powered agents. Get one at [aistudio.google.com](https://aistudio.google.com)
- **Anthropic API key** -- for security escalation to Claude and terminal sessions. Get one at [console.anthropic.com](https://console.anthropic.com)
- **Tailscale** -- for multi-node federation. Get it at [tailscale.com](https://tailscale.com)

### Hardware guidance
- **8GB RAM** (e.g., MacBook Air M4 base): runs Qwen 2.5 3B (setup wizard offers this as fallback)
- **16GB RAM**: runs Qwen 2.5 14B comfortably -- this is the default model
- **24GB+ RAM**: recommended for running multiple cloud-backed agents alongside local LLM

---

## Step 1: Install

```bash
# Clone the repo
git clone https://github.com/5RIndustries/darkhan.git
cd darkhan

# Install the pre-commit hook (blocks secrets, source maps, db files, keys, large files)
cp scripts/pre-commit-hook.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

# Install dependencies
cd server
npm install

# Pull the local LLM (14B is the default — needs 16GB+ RAM)
ollama pull qwen2.5:14b

# If your machine has less than 16GB RAM, use the smaller model instead:
# ollama pull qwen2.5:3b
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
| `OLLAMA_MODEL` | No | Your Ollama model name (default: `qwen2.5:14b`) |
| `GOOGLE_API_KEY` | If using Gemini agents | Your Google AI Studio API key |
| `ANTHROPIC_API_KEY` | If using security escalation | Your Anthropic API key |
| `OPENAI_API_KEY` | If using GPT consensus model | Your OpenAI API key |
| `FEDERATION_APPROVED_PEERS` | If using federation | Comma-separated list of approved peer hostnames. Federation is blocked unless this is set. |
| `DARKHAN_DEV_MODE` | No | Set to `true` to disable integrity checks during development. **Never enable in production** — all integrity monitoring is silently disabled. |

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
        "worker": "assistant.worker.js",
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
- Sets the default password to `changeme` (forced change on first login)
- Seeds default channels
- Generates API keys for agent accounts (stored in secrets.db)
- Sets permissions on secrets.db to 600 (owner-only read/write)
- Cleans stale databases from previous failed runs if detected

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
- **Maintenance startup cleanup** -- orphan process detection, stale heartbeat purging, expired session cleanup (automatic on every start)

**If the server refuses to start** with a `SESSION_SECRET` error, go back to Step 2 and ensure `SESSION_SECRET` is set in your `.env` file. There is no fallback -- this is a hard requirement.

---

## Step 6: First Login & Security Setup

1. Open `http://localhost:3001` in your browser (the setup wizard auto-opens this for you)
2. Log in with your username (lowercase, from your config's `name` field) and the default password `changeme`
3. **Darkhan handles the rest automatically with a gated first-login flow:**
   - A **forced password change overlay** appears immediately -- you must set a strong password (minimum 8 characters). This overlay cannot be dismissed.
   - After changing your password, a **forced lockdown PIN setup overlay** appears -- you must set a PIN (minimum 8 characters). This overlay cannot be dismissed either.
   - You cannot access any part of the app until both steps are complete.

**No need to find Settings manually.** The gated flow ensures every new user completes security setup before they can do anything else.

**Why the lockdown PIN matters:** If a security event triggers automatic lockdown, agents cannot unlock the system. You (the human admin) must authenticate via the web UI and provide the PIN to restore agent operations. The PIN hash is stored in `secrets.db` (not the main database), so even a worker with full database access to `darkhan.db` cannot read it.

### Execution Tier

After first-login setup, visit **Settings** to configure your **execution tier**. This controls how much autonomy agents have when using tools:

| Tier | Agent Can Do Without Asking | Still Requires Your OK |
|------|---------------------------|----------------------|
| **Supervised** (default) | Read files, search, browse | All writes, edits, commands |
| **Operational** | Code edits, file writes, commands, restarts | Credential access, auth changes, admin ops |
| **Autonomous** | Everything except security actions | Credential access, auth changes, admin ops |

**Security-sensitive operations always require approval regardless of tier.** This includes anything touching credentials, passwords, API keys, databases, admin actions, or destructive git operations. The boundary is enforced architecturally in the tool approval callback -- it cannot be bypassed by configuration or agent behavior.

Changes take effect on the next Claude session. You can change your tier at any time from Settings.

### Password Recovery

If a user forgets their password, an admin can generate a one-time recovery token:

1. Log in as admin and open **Settings**
2. Scroll to **Password Recovery**
3. Select the user from the dropdown and click **Generate Token**
4. Give the token to the user (it expires in 1 hour and works once)
5. The user clicks **Forgot password?** on the login page and enters their username, the token, and a new password

Recovery tokens are bcrypt-hashed in secrets.db. All recovery attempts are logged to the immutable audit trail.

Alternatively, use the break-glass tool from the terminal: `node break-glass.js reset-password` (requires lockdown PIN).

---

## Transcripts and Session Continuity

Darkhan automatically captures all channel conversations to `docs/transcripts/` every 30 minutes. This is a baseline capability -- no configuration required.

- **Daily files:** `docs/transcripts/Transcript_YYYY-MM-DD.md` -- one per day, code blocks stripped
- **Smart writes:** Only writes when new messages exist (no redundant writes overnight)
- **Session continuity:** When Claude sessions cycle (every 50 messages), the new session reads today's and yesterday's transcripts for full context
- **Shared space:** You can add your own notes, meeting records, or documents to `docs/` alongside transcripts -- writes to `docs/` never trigger the integrity lockdown

Transcripts are generated automatically on server startup and every 30 minutes thereafter.

---

## Step 7: Using the Integrated Terminal

Darkhan includes a built-in terminal directly in the web UI. Click **Terminal** in the sidebar to access it.

### Two Modes

| Mode | What It Does | Requirements |
|------|-------------|-------------|
| **Claude Code** | Interactive Claude Code session with full tool access | Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`) + Anthropic API key or Claude plan |
| **Shell** | General-purpose bash/zsh terminal for system commands, SSH, git, etc. | None (uses your system shell) |

Select the mode from the dropdown, then click **Start**.

### Unified Claude Session (Shared Context)

When you start a Claude Code terminal session, Darkhan creates a **unified session** — a single Claude brain shared between the terminal and chat interfaces.

- **Terminal is private.** Your terminal input and Claude's responses stay in the terminal. This is your direct workspace with Claude.
- **Chat is public.** Messages in channels are visible to all agents and humans. When you type in chat, Claude's response is posted to the channel for everyone to see.
- **Shared context.** Both interfaces use the same Claude session. Context from terminal conversations carries over to chat, and vice versa. Ask Claude something complex in the terminal, then reference it in chat — Claude remembers.
- **Session persistence.** If the server restarts, the session is automatically resumed from where it left off (session IDs are saved to disk).

### Chat Commands

Type these directly in any channel:

| Command | What It Does |
|---------|-------------|
| `/status` | Worker status, Claude session state, review gate state |
| `/review-gate on` | Enable output verification (local LLM reviews Claude responses before posting) |
| `/review-gate off` | Disable output verification |
| `/review-gate status` | Show review gate stats |
| `/help` | List all available commands |
| `@claude <message>` | Force message to Claude (bypasses local LLM triage) |
| `/quick <message>` | Force message to local LLM (Darkhan) |

### Pop-Out Window

Click the **arrow button** (&#8599;) in the terminal toolbar to open the terminal in a separate window. This is useful for multi-monitor setups:

- **Main screen:** Darkhan UI (channels, agents, dashboard)
- **Second screen:** Pop-out terminal (Claude Code or Shell, full height)

The pop-out window maintains its own connection and session. It auto-starts with your selected mode.

### Terminal Security

Terminal PTY sessions receive a filtered environment. Shell terminals get only: `HOME`, `PATH`, `LANG`, `USER`, `TERM`, `SHELL`, `TMPDIR`. Claude Code terminals additionally receive `ANTHROPIC_API_KEY` (required to function). All other environment variables — including `SESSION_SECRET`, `GOOGLE_API_KEY`, and any other secrets from `.env` — are not exposed to terminal sessions. This prevents credential exfiltration via `printenv`, `env`, or `echo $VAR`.

The relay session file (`~/.claude/darkhan-relay-sessions.json`) is written with mode 600 (owner-only read/write).

### Terminal Configuration

You can customize the default allowed tools for Claude terminal sessions in `darkhan.config.json`:

```json
{
  "terminal": {
    "allowedTools": "Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch,Agent"
  }
}
```

---

## Step 8: Security Hardening (Recommended)

These steps are optional for development but **strongly recommended for production deployments**.

### Mythos-Class Defenses (Two-LLM Consensus + Shell Allowlist)

If you are deploying Darkhan in an environment where agents process external input, federated messages, or where agents communicate with each other, enable the Mythos-class defenses.

**Two-LLM Consensus:** Requires a cloud LLM provider for the second classifier. Add to `.env`:

```
# Enable cloud-side security classification (second opinion on every external/agent message)
SECURITY_ESCALATION_PROVIDER=gemini
# or: SECURITY_ESCALATION_PROVIDER=anthropic

# Model for the cloud classifier (default: claude-haiku-4-5)
SECURITY_ESCALATION_MODEL=gemini-2.0-flash
```

With this configured, every external-origin and agent-origin message is classified by both the local Ollama model and the cloud provider. Both must agree the message is SAFE. If they disagree, the message is quarantined for human review in the alerts channel.

Without this configured, Darkhan falls back to single-model classification (local Ollama only). Single-model results are tagged as `safe_single` or `threat_single` so you know the reduced confidence level.

**Shell Allowlist Mode:** Instead of blocking known-dangerous commands (which is vulnerable to commands the blocklist does not anticipate), allowlist mode only permits explicitly listed commands. Add to `darkhan.config.json`:

```json
{
  "security": {
    "shellMode": "allowlist"
  }
}
```

The default allowlist permits: `ls`, `cat`, `head`, `tail`, `wc`, `date`, `echo`, `grep`, `find`, `sort`, `uniq`, `diff`, `pwd`, `whoami`, `uname`, `df`, `du`, `git`, `npm`, `ollama`, `pgrep`. To customize per-agent, add `shellAllowedCommands` to the agent's permissions:

```json
{
  "permissions": {
    "shell": "restricted",
    "shellAllowedCommands": ["ls", "cat", "head", "git", "npm"]
  }
}
```

**Agent-to-agent scanning** is always on and requires no configuration. All messages from agents (`from_user` starting with `agent_`) automatically go through the full scan pipeline including content normalization and two-LLM consensus (if configured).

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

## Step 9: Auto-Start with launchd

For production use, configure launchd so Darkhan starts automatically on boot and restarts on crash.

**If you completed Step 8 (service user),** use the provided plist template that runs as `_darkhan`:

```bash
sudo cp server/scripts/com.darkhan.server.plist /Library/LaunchDaemons/
sudo launchctl load /Library/LaunchDaemons/com.darkhan.server.plist
```

**If you skipped Step 8,** create a user-level plist:

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
- `DARKHAN_PATH` -- absolute path to your darkhan directory (e.g., `/Users/yourname/darkhan`)
- `YOUR_HOME` -- your home directory (e.g., `/Users/yourname`)

Then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.darkhan.server.plist
```

**Verify it is running:**

```bash
launchctl list | grep darkhan
# Should show a PID (first column) and exit status 0
```

**Important for launchd:** The `PATH` in `EnvironmentVariables` must include the directory where `node` is installed. launchd does not inherit your shell's PATH. If you use tools like `bun`, add its path here too (e.g., `/Users/yourname/.bun/bin`).

---

## Step 10: Write Your First Worker

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

## Step 11: Federated Setup (Multi-Node)

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
AGENT_ASSISTANT_API_KEY=dk_agent_...
WORKER_API_KEY=dk_agent_...
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
- [ ] Login works with default password `changeme`
- [ ] First-login gated flow forced you to change your password (minimum 8 characters)
- [ ] First-login gated flow forced you to set a lockdown PIN (minimum 8 characters)
- [ ] Messages appear in the #command channel
- [ ] Workers show as loaded: `curl -s http://localhost:3001/api/workers -H "X-API-Key: YOUR_KEY"`
- [ ] Agent status dots show green in the Health view
- [ ] Ollama responds: `curl -s http://localhost:11434/api/tags` shows your model
- [ ] Post "comms check" in #command -- all workers respond
- [ ] (If federated) Remote workers respond to comms check
- [ ] Maintenance ran on startup: check server log for `[Maintenance] Startup cleanup`
- [ ] Pre-commit hook installed: try `git commit --allow-empty -m "test"` -- should see "Pre-commit checks passed"

### Ground Truth & Verification
- [ ] Ground truth seeded: `curl -s http://localhost:3001/api/ground-truth -H "X-API-Key: YOUR_KEY"` returns entries
- [ ] Ground truth brief: `curl -s http://localhost:3001/api/ground-truth/brief/text -H "X-API-Key: YOUR_KEY"` returns readable text
- [ ] Hash chain active: `curl -s http://localhost:3001/api/activity/chain-head -H "X-API-Key: YOUR_KEY"` returns a hash

### Mythos Defenses (if configured in Step 8)
- [ ] Two-LLM consensus active: check server startup logs for `SECURITY_ESCALATION_PROVIDER` confirmation
- [ ] Consensus works: post a test message from an agent and check the activity log for `two_llm_consensus` entries: `curl -s "http://localhost:3001/api/activity?action=two_llm_consensus&limit=5" -H "X-API-Key: YOUR_KEY"`
- [ ] Shell allowlist mode (if enabled): verify a blocked command is rejected: have an agent attempt `curl https://example.com` and confirm it is blocked with "not in allowlist"
- [ ] Agent-to-agent scanning: verify agent messages show `origin: "agent"` in their security metadata

### Integrity Hardening
- [ ] Baseline anchor stored: `sqlite3 server/db/darkhan.db "SELECT key FROM settings WHERE key='baseline_anchor';"` returns a row
- [ ] Ed25519 private key in secrets.db: `sqlite3 server/db/secrets.db "SELECT key FROM instance_keys;"` shows `ed25519_private`
- [ ] Private key removed from main DB: `sqlite3 server/db/darkhan.db "SELECT key FROM instance_identity;"` shows only `ed25519_public` (no `ed25519_private`)
- [ ] Federation gate active: check server startup logs for `Federation disabled: no approved peers configured` (unless you have set `FEDERATION_APPROVED_PEERS`)
- [ ] Node provenance recorded: `sqlite3 server/db/darkhan.db "SELECT key, value FROM instance_identity WHERE key LIKE 'node_%';"` shows birth certificate data
- [ ] Deploy mode available: `node server.js --deploy` prompts for lockdown PIN (exit with Ctrl+C after verifying)

### Security Hardening (if completed Step 8)
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
| npm audit shows vulnerabilities | Outdated dependencies | Run `npm audit fix`. If transitive, check if the parent package has an update. |
| Orphan processes from previous crash | Stale PID file | Restart Darkhan normally -- the maintenance service auto-cleans orphans on startup |

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

### Installation Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `better_sqlite3.node` not found after rsync | Native modules copied from different OS/arch | Run `npm install` on the target machine — native modules must be compiled locally |
| Lockdown triggers immediately on first boot | Integrity baseline from a previous install detects schema changes | Delete `~/.darkhan-integrity-baseline.json` and restart. First boot after deletion creates a clean baseline |
| Homebrew install fails (needs sudo) | No admin password on the machine | See [No Homebrew / No sudo?](#no-homebrew--no-sudo-manual-install) for manual Node.js and Ollama installation |
| `ollama` not found after install | Not on PATH | Add `~/local/bin` to PATH in `~/.zprofile`, or symlink: `ln -sf /path/to/ollama ~/local/bin/ollama` |

### Ollama Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "connection refused" on 11434 | Ollama not running | `brew services start ollama` or `ollama serve &` (if installed without Homebrew) |
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

## Step 12: VPS Deployment (Optional)

If you are deploying Darkhan on a virtual private server instead of a local machine, additional configuration is required. Darkhan was designed for trusted networks and needs a safety net for public internet exposure.

### Recommended: Caddy Reverse Proxy

```bash
# Install Caddy (handles automatic HTTPS via Let's Encrypt)
sudo apt install -y caddy    # Debian/Ubuntu
# or: brew install caddy      # macOS

# /etc/caddy/Caddyfile
darkhan.yourdomain.com {
    reverse_proxy localhost:3001
}

sudo systemctl reload caddy
```

### Environment Variables for VPS

Add these to your `.env`:

```
# Trust proxy headers (required behind Caddy/nginx/Cloudflare)
DARKHAN_TRUST_PROXY=true

# Enable secure cookie flags
DARKHAN_HTTPS=true

# Restrict WebSocket connections to your domain
DARKHAN_ALLOWED_ORIGINS=https://darkhan.yourdomain.com
```

### What These Enable

| Protection | What It Does |
|-----------|-------------|
| Trust proxy | Reads client's real IP from `X-Forwarded-For` so rate limiting works correctly |
| WebSocket origin validation | Rejects cross-site WebSocket hijacking attempts |
| Per-IP rate limiting | 5 failed logins per IP per 15 minutes (always active, but useless without trust proxy) |
| Secure cookies | `secure`, `sameSite: strict`, `httpOnly` flags on session cookies |
| Startup safety warning | Alerts you if binding externally without TLS |

### Alternative: Tailscale

If you do not need public access, use Tailscale for encrypted private networking:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Access Darkhan via Tailscale IP: http://100.x.y.z:3001
```

See [SECURITY.md](SECURITY.md#vps-deployment-hardening) for the full threat model and VPS hardening details.

---

## Next Steps

- Read [README.md](README.md) for full architecture documentation
- Read [WORKER-CONTRACT.md](WORKER-CONTRACT.md) before writing workers
- Explore the web UI: check Health, Costs, and Folio views
