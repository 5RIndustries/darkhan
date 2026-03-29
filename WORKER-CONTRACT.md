# Darkhan Worker Runtime Contract v1.0

> This document defines exactly what a worker is, what it receives, and how it behaves.
> Read this before writing any worker code.

---

## Table of Contents

1. [What Is a Worker](#what-is-a-worker)
2. [Worker Module Structure](#worker-module-structure)
3. [Runtime-Provided Interfaces](#runtime-provided-interfaces)
4. [Execution Policies](#execution-policies)
5. [Agent Permissions](#agent-permissions)
6. [Rate Limiting Integration](#rate-limiting-integration)
7. [Onboarding Injection](#onboarding-injection)
8. [Ground Truth](#ground-truth)
9. [Federated Workers](#federated-workers)
10. [Writing a Worker: Checklist](#writing-a-worker-checklist)
11. [Error Handling Patterns](#error-handling-patterns)
12. [Testing Workers](#testing-workers)

---

## What Is a Worker

A worker is a JavaScript module that defines an agent's behavior through two mechanisms:

1. **Scheduled tasks** -- cron-driven jobs that run on a schedule (digests, scans, audits)
2. **Message listeners** -- event-driven responses triggered when a message matches a pattern (comms checks, @mentions, direct questions)

Workers are loaded from `server/workers/` on server start. The runtime handles scheduling, error isolation, and provides each worker with the `llm`, `darkhan`, `tools`, `config`, and `log` interfaces.

Workers never interact with the database, filesystem, or network directly. Everything goes through the provided interfaces, which enforce permissions and log activity.

---

## Worker Module Structure

```javascript
module.exports = {
  id: 'agent_chief',           // MUST match a team member ID in darkhan.config.json
  name: 'Chief',

  // Called once when the worker is loaded at server start
  async onLoad({ llm, darkhan, tools, config, log }) {
    log.info('Chief worker loaded');
    await darkhan.post('chan_command', 'Chief online.');
  },

  // --- Scheduled Tasks ---
  tasks: {
    task_name: {
      schedule: '0 */4 * * *',   // Standard cron syntax (node-cron)
      timeout: 300000,            // Max runtime in ms (default: 5 min)
      retryOnFail: false,         // Retry once on uncaught error (default: false)
      runOnLoad: false,           // Run immediately on server start (default: false)

      async run({ llm, darkhan, tools, config, log }) {
        // Task implementation
      }
    }
  },

  // --- Message Listeners ---
  listeners: {
    listener_name: {
      patterns: [/^comms?\s*check$/i, /@chief/i],  // Regex patterns to match
      timeout: 15000,              // Max runtime in ms (default: 60s)

      // Receives context + message details
      async run({ llm, darkhan, tools, config, log }, { channelId, fromUser, body }) {
        await darkhan.post(channelId, 'Standing by.');
      }
    }
  }
};
```

---

## Runtime-Provided Interfaces

Every task and listener `run()` function receives these interfaces as its first argument. The runtime injects them; workers never construct them.

### `evidence` -- Evidence-Based Reporting

```
evidence.check({ claim, method, target, check })
  -> { claim, method, target, result: { pass, actual, detail?, error? }, timestamp, hash }
```

- The `check` function runs a code-level verification (fs.stat, DB query, etc.)
- Result is hashed with SHA-256: `hash = SHA-256(claim + method + JSON(result) + timestamp)`
- Evidence is automatically appended to the immutable activity log
- Use for security audits, compliance checks, or any assertion that needs tamper-evident proof

```
evidence.buildReport({ title, findings, llmAnalysis?, metadata? })
  -> Formatted markdown report with verified findings, evidence hashes, and optional LLM analysis
```

- Produces a deterministic facts section from evidence data
- LLM analysis (if provided) is clearly labeled as advisory, not verified fact

```
evidence.buildFindingsSummary(findings)
  -> Plain-text summary of PASS/FAIL results for LLM consumption
```

- Strips hashes and formatting -- only passes facts to the LLM
- Use this as input when asking an LLM to analyze findings

**Example usage in a worker task:**

```javascript
async run({ evidence, darkhan, log }) {
  const findings = [];

  findings.push(await evidence.check({
    claim: 'Config file is valid JSON',
    method: 'fs.readFile + JSON.parse',
    target: '/path/to/config.json',
    check: async () => {
      const raw = await fs.promises.readFile(target, 'utf8');
      JSON.parse(raw);
      return { pass: true, actual: 'Valid JSON' };
    },
  }));

  const report = evidence.buildReport({
    title: 'Config Audit',
    findings,
    metadata: { agent: 'My Agent' },
  });
  await darkhan.alert(report);
}
```

### `llm` -- LLM Interface

```
llm.complete({ provider?, model?, messages, options?, validation? })
  -> { response: string, usage: { inputTokens, outputTokens, cost } }
```

- Checks rate limits before sending (rejects with `RateLimitError` if over budget)
- Logs usage to the cost tracker automatically
- Default provider/model from the agent's config if not specified
- Timeouts: 60s for Ollama, 30s for cloud APIs
- The onboarding identity preamble is prepended to every LLM call automatically

```
llm.classify({ text, categories, provider?, model? })
  -> { category: string, confidence: number }
```

- Helper that wraps `complete()` with a classification prompt
- Constrains output to one of the provided categories
- Useful for triage, routing, and intent detection

### `darkhan` -- Command Center Interface

```
darkhan.post(channelId, body, options?)
  -> Posts a message to a Darkhan channel as this agent

darkhan.alert(body)
  -> Shortcut for darkhan.post('chan_alerts', body)

darkhan.getMessages(channelId, { since?, limit? })
  -> Returns recent messages from a channel

darkhan.createTask({ title, assignee, priority?, description? })
  -> Creates a task in the task system

darkhan.ping(status?)
  -> Sends a heartbeat ping (also called automatically by runtime every 30s)

darkhan.flagThreat({ category, severity, description, evidence })
  -> Posts a structured threat alert to chan_alerts AND creates a CRISPR defense spacer in the hash chain.
     Use for: injection attempts, anomalous behavior, data exfiltration signals, integrity violations.
     - category: string (e.g. 'injection', 'exfiltration', 'anomaly', 'integrity')
     - severity: 'low' | 'medium' | 'high' | 'critical'
     - description: human-readable summary
     - evidence: optional object with supporting data
```

**Identity enforcement:** The `darkhan.post()` method always posts as the authenticated agent. A worker cannot impersonate another agent or a human. The system will override any attempt and log it.

**Claim verification:** Every agent message posted via `darkhan.post()` is automatically scanned by the Claim Verifier before being saved. The verifier checks:
- File references ("saved to Intel/report.md") against the filesystem
- Status claims ("Lindsey is operational") against the heartbeat table
- Numeric claims ("scanned 47 messages") tagged as self-reported

Verification results are stored in the message's `metadata.claimVerification` field. This is non-blocking -- the verifier never modifies the message body or prevents posting. It only adds trust signals for human review.

### `tools` -- External Tool Access

```
tools.fs.read(path)         -> Read a file from the vault
tools.fs.write(path, data)  -> Write a file (respects agent write permissions)
tools.fs.exists(path)       -> Check if a file exists
tools.fs.readdir(path)      -> List directory contents
tools.fs.glob(pattern)      -> Find files matching a glob pattern
tools.fs.grep(pattern, path) -> Search file contents

tools.shell.exec(command, { timeout?, cwd? })
  -> Execute a shell command (sandboxed per agent config)
```

**File write restrictions:** Each agent has a list of permitted write directories in its config. Writes outside those directories are rejected and logged.

**Sandbox enforcement:** When the native sandbox is enabled, `tools.fs.read()` and `tools.fs.write()` enforce a filesystem deny-list in addition to the per-agent write permissions. Access to `db/`, `.env`, `.ssh/`, `.gnupg/`, and TLS certificate directories is blocked at the OS level. This applies even if the agent has `"shell": "full"` -- the sandbox operates below the permission layer.

**Shell restrictions:** Agents with `"shell": "restricted"` cannot run dangerous commands (rm, sudo, kill, curl to external hosts, ssh, etc.). Agents with `"shell": "none"` cannot run any shell commands. Violations are logged and contribute to lockdown thresholds.

### `config` -- Agent Configuration

```
config.id          -> 'agent_chief'
config.name        -> 'Chief'
config.model       -> { provider: 'ollama', model: 'qwen2.5:14b' }
config.schedule    -> { ... }
config.rateLimits  -> { requestsPerDay: 0, ... }
config.channels    -> ['chan_command', 'chan_alerts']
config.permissions -> { fsWrite: [...], shell: 'restricted' }
```

Read-only. Reflects the agent's entry in `darkhan.config.json`.

### `log` -- Structured Logger

```
log.info(message, data?)    -> Info-level log (also writes to activity log)
log.warn(message, data?)    -> Warning
log.error(message, data?)   -> Error (also posts to chan_alerts)
```

All log calls are automatically tagged with the agent ID and timestamp. They write to both stdout and the immutable activity log.

---

## Execution Policies

### Scheduling

- Uses `node-cron` for standard cron expressions
- Timezone from agent config (default: `America/New_York`)
- Tasks that are still running when the next trigger fires: **SKIP** (log warning, do not queue)

### Error Handling

- Each task runs inside try/catch
- Uncaught errors: logged, posted to chan_alerts, task marked failed
- Worker crash does NOT crash the Darkhan server
- If `retryOnFail: true`, retry once after 60s delay

### Timeout

- Default: 5 minutes per task, 60 seconds per listener
- Configurable per task/listener via the `timeout` field
- On timeout: task is killed, error logged, chan_alerts notified

### Concurrency

- Tasks within the same worker: **SEQUENTIAL** (one at a time)
- Tasks across different workers: **PARALLEL** (independent)
- This prevents a single agent from overwhelming system resources
- Listeners run in parallel across workers and do not block scheduled tasks

### Message Listeners

- Listeners are registered when the worker loads
- When a message arrives, the auto-responder checks all registered listener patterns
- If any listener matches, it runs the listener handler
- Multiple workers can match the same message (e.g., "comms check" triggers all workers)
- Listeners run in parallel across workers
- A worker will not respond to its own messages (prevents infinite loops)
- Local workers: triggered immediately via WebSocket events
- Federated workers: triggered via 5-second polling against the hub's message API

### Startup

- Workers are loaded on server start
- `onLoad()` called once per worker
- First scheduled run follows cron timing (not immediate, unless `runOnLoad: true`)
- Onboarding brief is injected before `onLoad()` is called

### Shutdown

- On SIGTERM/SIGINT: cancel pending tasks, wait up to 10s for running tasks to finish
- Save any state needed in `onLoad()` cleanup (if implemented)
- Log clean shutdown

---

## Agent Permissions

Each agent has a permission set defined in `darkhan.config.json`. The `tools` interfaces enforce these at runtime.

| Permission | Config Key | Options |
|-----------|------------|---------|
| File read | (implicit) | All agents can read the full vault |
| File write | `permissions.fsWrite` | Array of permitted directory prefixes |
| Shell access | `permissions.shell` | `full`, `restricted`, `none` |
| LLM providers | `model.provider` + `rateLimits` | Provider and daily/per-minute budgets |
| Channel access | `channels` | Array of channel IDs the agent can post to |

**Example permission config:**

```json
{
  "permissions": {
    "fsWrite": ["project/output/", "project/reports/"],
    "shell": "restricted"
  }
}
```

**Restricted shell commands** (blocked for agents with `"shell": "restricted"`):
- `rm`, `rmdir` -- file deletion
- `sudo`, `su` -- privilege escalation
- `kill`, `killall`, `pkill` -- process termination
- `curl`, `wget` (to external hosts) -- network access
- `ssh`, `scp`, `nc`, `ncat` -- remote access
- `python`, `python3`, `node`, `perl`, `ruby`, `php` -- interpreter commands (prevents arbitrary code execution)
- Pipe to shell (`| bash`, `| sh`, `| zsh`, `| node`, `| python`) -- blocked
- Command substitution (`$(...)` and backticks) -- blocked in restricted mode
- Access to sensitive file paths (`.env`, database files, secrets, tokens, etc.)

**Environment whitelist:** Shell commands executed by workers receive only these environment variables:
- `HOME` -- user home directory
- `PATH` -- system path
- `LANG` -- locale (defaults to `en_US.UTF-8`)
- `USER` -- current user
- `TERM` -- terminal type (defaults to `xterm-256color`)

All other environment variables (including `SESSION_SECRET`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, and any other secrets in `.env`) are **not** passed to worker shell processes. This prevents a worker from reading secrets via `printenv`, `env`, or `echo $VAR`.

---

## Rate Limiting Integration

Workers do not manage their own rate limits. The `llm` interface handles it transparently:

1. Worker calls `llm.complete()`
2. Rate limiter checks the agent's daily budget (from config)
3. Rate limiter checks the provider's per-minute rate (global)
4. If within limits: send request, log cost
5. If agent over daily budget: throw `BudgetExceededError`
6. If provider at per-minute limit: queue with backoff (max wait: 60s, then throw `RateLimitError`)

Workers should handle these errors gracefully:

```javascript
try {
  const result = await llm.complete({ ... });
} catch (e) {
  if (e.name === 'BudgetExceededError') {
    log.warn('Daily budget exceeded, skipping remaining work');
    return;
  }
  if (e.name === 'RateLimitError') {
    log.warn(`Rate limited, retry after ${e.retryAfterMs}ms`);
    return; // Or implement retry logic
  }
  throw e; // Let runtime handle other errors
}
```

---

## Onboarding Injection

At startup, the Onboarding Service generates a verified brief for each agent containing:
- Agent identity (name, role, chain of command)
- Operating rules (honesty mandates, permission boundaries, anti-hallucination directives)
- Current system state (derived from live configuration, not cached)

This brief is:
1. Available as context during `onLoad()`
2. Prepended as a system message to every `llm.complete()` call
3. Impossible for the agent to modify or override

The onboarding system ensures that agents start every session with accurate ground truth about who they are and what they can do.

---

## Ground Truth

The Ground Truth Registry (`/api/ground-truth`) is the canonical source of verified facts. Agents should query it to avoid contradicting established ground truth.

**How to use in a worker:**

```javascript
async run({ darkhan, tools, log }) {
  // Get the full ground truth brief as plain text (suitable for LLM context)
  const brief = await tools.http.get('/api/ground-truth/brief/text');

  // Include in LLM prompts to prevent contradiction
  const result = await llm.complete({
    messages: [
      { role: 'system', content: `Verified facts:\n${brief}` },
      { role: 'user', content: 'Summarize current infrastructure status.' }
    ]
  });
}
```

**What happens automatically:** The Claim Verifier checks every agent message against the ground truth registry before storage. If an agent claims "Node 2 has 16GB RAM" but the registry says "Node 2 has 24GB RAM", the contradiction is flagged in the message's `metadata.claimVerification` field.

Agents do not need to call the ground truth API directly for contradiction detection -- it happens transparently on every `darkhan.post()`. However, proactively including the brief in LLM prompts prevents contradictions from being generated in the first place.

---

## Federated Workers

Workers can run on a remote node using the `FederatedWorkerRuntime` (via `remote-runner.js`). The worker code is identical -- the same `.worker.js` file works on both local and federated runtimes. The differences are transparent to the worker:

| Behavior | Local Runtime | Federated Runtime |
|----------|--------------|-------------------|
| `darkhan.post()` | Direct database insert + WebSocket | HTTP POST to hub API |
| `darkhan.getMessages()` | Direct database query | HTTP GET from hub API |
| `darkhan.ping()` | Direct database update | HTTP POST to hub API |
| `tools.fs.read()` | Local filesystem | HTTP GET from hub's vault API |
| Listener triggering | WebSocket event | 5-second polling against hub |
| Rate limiting | Local enforcement | Hub-side enforcement via API key |

**Writing portable workers:** If your worker uses only the provided interfaces (`llm`, `darkhan`, `tools`, `config`, `log`), it will work on both local and federated runtimes without modification.

---

## Writing a Worker: Checklist

Before deploying a new worker:

- [ ] `id` in the worker file matches `id` in `darkhan.config.json`
- [ ] Agent entry exists in `darkhan.config.json` with `worker` field pointing to the file
- [ ] Heartbeat task exists (schedule: `*/5 * * * *`) -- required for health monitoring
- [ ] All LLM calls handle `BudgetExceededError` gracefully
- [ ] All `darkhan.post()` calls target channels listed in the agent's config
- [ ] File writes target only permitted directories
- [ ] Shell commands (if any) are compatible with the agent's shell permission level
- [ ] Listeners include a "comms check" handler (convention: all workers respond)
- [ ] Timeouts are set appropriately (default 5 min for tasks, 60s for listeners)
- [ ] `onLoad()` logs a startup message and posts to a channel so humans know it is online
- [ ] Tested locally before deploying to production

---

## Error Handling Patterns

### Graceful degradation when LLM is unavailable

```javascript
async run({ llm, darkhan, log }) {
  try {
    const result = await llm.complete({ ... });
    await darkhan.post('chan_command', result.response);
  } catch (e) {
    if (e.name === 'BudgetExceededError') {
      log.warn('Budget exceeded, posting static fallback');
      await darkhan.post('chan_command', 'Daily LLM budget reached. Task deferred to tomorrow.');
      return;
    }
    if (e.code === 'ECONNREFUSED') {
      log.error('Ollama not reachable');
      return;
    }
    throw e;
  }
}
```

### Long-running tasks with progress updates

```javascript
async run({ llm, darkhan, log }) {
  await darkhan.post('chan_command', 'Starting daily analysis...');

  // Step 1
  const data = await tools.fs.read('project/status.md');
  log.info('State file loaded');

  // Step 2
  const result = await llm.complete({
    messages: [{ role: 'user', content: `Analyze: ${data}` }],
    options: { temperature: 0.3 },
  });

  // Step 3
  await tools.fs.write('project/output/analysis.md', result.response);
  await darkhan.post('chan_command', 'Analysis complete. Saved to project/output/analysis.md.');
}
```

### Listener with input validation

```javascript
listeners: {
  status_request: {
    patterns: [/^status\s+(\w+)$/i],
    timeout: 30000,
    async run({ darkhan, log }, { channelId, fromUser, body }) {
      const match = body.match(/^status\s+(\w+)$/i);
      if (!match) return; // Pattern matched but capture failed -- skip

      const target = match[1].toLowerCase();
      // ... look up status for target ...
      await darkhan.post(channelId, `Status for ${target}: operational`);
    }
  }
}
```

---

## Testing Workers

### Manual testing

1. Add `runOnLoad: true` to the task you want to test
2. Start Darkhan: `node server.js`
3. Watch the console output and check the channel for the task's messages
4. Remove `runOnLoad: true` after testing

### Verifying a running worker

```bash
# Check if the worker is loaded
curl -s http://localhost:3001/api/workers -H "X-API-Key: YOUR_KEY"

# Check agent health
curl -s http://localhost:3001/api/health/status -H "X-API-Key: YOUR_KEY"

# Check recent activity
curl -s "http://localhost:3001/api/activity?actor=agent_myagent&limit=10" -H "X-API-Key: YOUR_KEY"
```

### Comms check

Post "comms check" in the #command channel. Every healthy worker should respond within a few seconds (local) or within the 5-second polling interval (federated).
