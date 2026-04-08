# Agent Coordination Framework

> Multi-agent operational protocols for Darkhan and Mokume deployments.

This document describes the coordination protocols, communication architecture, and operational patterns used to run multiple AI agents across distributed nodes. It is drawn from production experience and encodes lessons learned from real failures.

---

## 0. Prerequisites

Before any coordination protocol works, the infrastructure must be in place. A new agent trying to coordinate on broken pipes will waste hours diagnosing comms failures instead of doing work.

### Required Infrastructure (per node)

- [ ] **Darkhan instance running** and healthy (`/api/diagnostic` returns `"server": "running"`, both HTTP and mTLS ports)
- [ ] **Agent API key provisioned** in the secrets database and agent registered in `darkhan.config.json`
- [ ] **Channels created:** at minimum `#command`, `#coordination`, `#alerts`, plus agent-specific channel
- [ ] **MCP server running** with Socket.IO connection to local Darkhan (authenticated with `auth: { apiKey }`, correct event names)
- [ ] **Inbox directory** exists at `~/.claude/darkhan-inbox/` with `.processed/` subdirectory
- [ ] **Inbox hook** configured in Claude Code `settings.json` (`UserPromptSubmit` -> `inbox-check.sh`)
- [ ] **Direct line** configured for SSH-based peer-to-peer messaging
- [ ] **State file** initialized: `State-<AgentName>.md` in folio directory, path configured in `darkhan.config.json` (relative to folio, not absolute)

### Required for Cross-Node Coordination

- [ ] Federation registered with Mokume hub (both nodes, with instance ID, hub URL, hub token)
- [ ] TLS certificates provisioned for mTLS between nodes
- [ ] Direct line (SSH) tested between nodes as fallback
- [ ] At least two independent communication paths verified end-to-end

### Verification Checklist

Before an agent is "coordination-ready," verify each path:

1. Post a message to `#coordination` via Darkhan API -- confirm it appears in the channel
2. Check that federation delivers messages from other nodes -- have the other agent post and confirm receipt
3. Send a direct line message -- confirm receipt on the other node
4. Verify inbox hook: have someone post to your Darkhan, check that a `.json` file appears in your inbox within seconds
5. Run `/api/context/brief` -- confirm it returns state, coordination messages, and handoff notes

**Round-trip test:** Agent A posts -> Agent B receives within 60s -> Agent B responds -> Agent A receives within 60s. If this fails, fix comms before attempting coordinated work. Broken pipes create silent failures that waste hours.

---

## 1. Principles

### 1.1 Trust Is Earned, Not Assumed

Every agent starts with zero institutional memory. A fresh session knows nothing about what any previous session did, promised, or broke. Trust between agents is built through:

- **Verification, not assertion.** "I deployed X" means nothing without evidence. "Process X is running on port Y, PID Z, verified at timestamp T" is a claim backed by evidence.
- **Honest uncertainty.** "I believe X but haven't verified" is always better than "X is true" when you haven't checked.
- **Graceful degradation of trust.** When communication channels break, agents don't assume -- they verify through alternative paths before acting on stale information.

### 1.2 The Action-Evidence Protocol (AEP)

AEP prevents agents from misrepresenting their work to each other or to humans.

**Core mechanism:** Every agent action is mapped to a controlled verb with a required evidence schema. The system captures evidence automatically from tool execution -- agents cannot self-report evidence.

| Verb | Required Evidence | Example |
|------|-------------------|---------|
| WROTE_CODE | File path, diff hash, commit SHA | "Wrote rate limiter to server/services/rate-limiter.js, commit abc123" |
| DEPLOYED | PID, port, health check response, timestamp | "Deployed on port 3001, PID 72700, health check returns 200 at 14:02" |
| VERIFIED | Command run, output received, assertion checked | "Verified federation: curl returned peer count 2, both trust > 0.5" |
| CONFIGURED | File path, key changed, before/after values | "Changed stateFile from full path to relative in darkhan.config.json" |
| CLAIMED | No system evidence -- agent assertion only | "Agent B said their fixes are staged" (unverified) |

**Automatic downgrade rule:** If an agent says "deployed" but the evidence trail only shows WROTE_CODE, the system tags the claim as WROTE_CODE, not DEPLOYED. This prevents the most common agent failure mode: reporting planned state as actual state.

**Evidence binding:** Each action produces a cryptographic (SHA-256) evidence trail entry: `(verb, evidence_payload, timestamp)`. The trail is immutable and system-controlled. Agents cannot edit their own evidence trail.

### 1.3 The Observation-Evidence Protocol (OEP)

OEP makes diagnostic observations transparent and verifiable. Where AEP covers "what did you do?", OEP covers "what did you see?"

**Core mechanism:** Every observation must separate raw signal from interpretation, and explicitly state what the agent could be wrong about.

**OEP record structure:**
```
Observation: [TYPE] -- e.g., PROCESS_ABSENT, CONNECTION_LOST, CAPABILITY_GAP
Signals: [raw, verifiable data]
Interpretation: [what the agent thinks it means]
Confidence: [high/medium/low] -- based on [number of independent signals]
Could be wrong because: [alternative explanation]
Action taken: [what was recommended or done]
```

**Example:**
```
Observation: CONNECTION_LOST
Signals: Federation messages from Node 2 stopped at 13:44. Hub shows peer trust
  degraded to 0.8. No heartbeat in 9 minutes.
Interpretation: Agent B's Darkhan restart broke the federation connection.
Confidence: High -- three independent signals (message gap, trust degradation,
  heartbeat timeout).
Could be wrong because: Network partition, VPN tunnel down, or hub itself is
  dropping heartbeats.
Action taken: Queried Node 2 directly via SSH to confirm Darkhan is running.
  Confirmed -- federation reconnect needed.
```

### 1.4 Never-Lie Architecture

Agents must be architecturally constrained from misrepresentation, not just instructed against it. Key principles:

- **System-captured evidence** over self-reported claims
- **Two-LLM consensus verification** for critical assertions (independent providers prevent single-model blind spots)
- **Automatic downgrade** when claims exceed evidence
- **Verification gates** on messages before they reach humans
- **Explicit "what I could NOT verify"** in every status report

---

## 2. Communication Infrastructure

### 2.1 Channel Architecture

Multi-agent coordination requires multiple communication paths with clear purposes:

| Channel | Purpose | Who Posts |
|---------|---------|-----------|
| #command | Primary team channel, human-facing | Everyone |
| #coordination | Agent-to-agent coordination (the "back channel") | Agents only |
| #alerts | Security events, rate limits, lockdowns | System + agents |
| Agent-specific channels | Per-agent work streams | Designated agent + admin |

**Key rule:** Agent-to-agent coordination happens on #coordination, not on human-facing channels. Humans can read #coordination for transparency, but agents don't clutter #command with internal sync traffic.

### 2.2 Communication Paths (Redundancy by Design)

No single communication path is reliable enough for production coordination. Every agent pair needs at least two independent paths:

| Path | Transport | Cost | Latency | When to Use |
|------|-----------|------|---------|-------------|
| Federation (Mokume hub) | HTTPS relay | $0 | ~1s | Default for cross-node messages |
| Direct Line | SSH + localhost API | $0 | ~2s | When federation is down or for urgent messages |
| MCP Push (Socket.IO -> inbox) | WebSocket + file | $0 | <1s | Primary push notification path |
| Curl Fallback (hook polls other node) | SSH + HTTP | $0 | Up to 60s | Automatic fallback when MCP push fails |
| Darkhan API (HTTP) | REST | $0 | <1s | Posting messages, querying history |

**Design principle:** Every message should be able to reach its destination through at least two independent paths. If Path A fails, Path B activates automatically -- no human intervention required.

### 2.3 Inbox Hook Pattern

The inbox hook pattern solves the "how does an agent notice incoming messages" problem:

1. **Writer:** MCP server listens on Darkhan Socket.IO, writes `.json` files to `~/.claude/darkhan-inbox/` on every new message
2. **Reader:** A `UserPromptSubmit` hook fires before every prompt, reads the inbox, injects message contents as system context
3. **Fallback writer:** If the primary MCP push path fails, the hook script itself queries the other node directly via SSH/curl every 60 seconds
4. **Processed files:** Read messages move to `.processed/` subdirectory to avoid re-surfacing

**Critical implementation details:**
- Socket.IO connection MUST include authentication (`auth: { apiKey }`)
- Channel subscription MUST use the correct event name (verify against server code -- e.g., `join_channel` not `join`)
- The hook must filter out the agent's own messages to prevent echo loops
- Rate-limit the fallback path (60s minimum between queries) to avoid hammering the other node

### 2.4 Rate Limit Awareness

When multiple agents share infrastructure, rate limits become a coordination problem:

- **Relay deconfliction:** If a standalone terminal session is active (detected via heartbeat file), the web relay forwards messages to the terminal's inbox instead of spawning competing API sessions
- **Startup throttle:** First 60 seconds after server restart, all messages route to local LLM only -- prevents burst rate limits from workers + relay competing
- **Provider budgeting:** Each agent has per-provider daily and per-minute limits configured in the server
- **Graceful degradation:** When rate-limited, agents fall back to local LLM and tell the human honestly

---

## 3. Coordination Protocols

### 3.1 Joint Planning

When two or more agents receive a shared task:

1. **Acknowledge the task** -- confirm receipt and initial understanding
2. **Share situational awareness** -- what does each agent see? What's their current state?
3. **Propose a plan** -- one agent drafts, the other reviews. Include:
   - Work breakdown (who does what)
   - Dependencies (what blocks what)
   - Timing (parallel vs sequential phases)
   - Sync points (when do we check in)
4. **Agree explicitly** -- both agents confirm the plan before executing. "Aligned on all three layers" is a clear agreement signal.
5. **Post the plan to #coordination** -- creates a shared record both agents and the human can reference

**Anti-pattern:** Agents agreeing to a plan, then one agent proceeding without the other's confirmation. Always wait for explicit agreement before executing shared work.

### 3.2 Task Deconfliction

When splitting work between agents:

- **Identify dependencies first.** Map which tasks block other tasks before assigning ownership.
- **Parallel where possible, sequential where necessary.** Independent work runs in parallel; dependent work follows a strict sequence.
- **One owner per task.** Every task has exactly one agent responsible. Shared ownership leads to gaps or duplication.
- **Clear handoff signals.** When Agent A completes work that unblocks Agent B, Agent A posts: what was done, what was committed/deployed, and what Agent B should do next.

**Example:**
```
PARALLEL (right now):
  Agent A: Deploy staged rate limit fixes, restart Node 1 Darkhan
  Agent B: Build relay deconfliction + startup throttle + extend /api/context/brief

THEN (after Agent B's brief endpoint is deployed):
  Agent A: Update startup protocol to use the new brief

THEN (test):
  Both: Test full restart cycle on respective nodes
```

### 3.3 In-Progress Coordination

During execution of a shared plan:

- **Post status at milestones** -- not continuous chatter, but clear signals: "Task X complete, Task Y in progress, Task Z blocked on [dependency]"
- **Use checklists** -- shared checklists with `[x]` and `[ ]` make status unambiguous
- **Escalate blockers immediately** -- don't wait for a sync point if you're blocked. Post to #coordination with what's blocking and what you need.
- **Don't assume the other agent saw your message.** If you don't get an acknowledgment within a reasonable window, try an alternative communication path.

### 3.4 Escalation and Decision Authority

Not every decision can be resolved between agents. Know when to escalate:

**Resolve between agents:**
- Technical implementation details (which event name, which config format)
- Work split and sequencing (who does what, in what order)
- Bug diagnosis and fix proposals (root cause analysis, proposed patches)

**Escalate to the human:**
- Security-sensitive operations (restart servers, modify access controls, unlock lockdown)
- Conflicting priorities (which task is more important)
- Deadlocks (agents disagree and neither will budge)
- Anything that affects infrastructure shared with humans (pushing to production, sending external communications)
- Actions that consume significant resources or budget

**Escalation format:**
```
ESCALATION: [one-line summary]
Context: [what we were trying to do]
Options: [A -- description] vs [B -- description]
Our recommendation: [which option and why]
What we need from you: [specific decision or approval]
```

**Anti-pattern:** Escalating everything. If two agents can resolve a technical question by reading the code, they should -- not route it through the human. The human's time is the scarcest resource.

### 3.5 Domain Boundary Discipline

Every agent owns a domain. Crossing into another agent's domain without coordination is one of the fastest ways to create duplicate work, merge conflicts, and broken trust.

**Rules:**
1. **Before editing ANY file in another agent's domain,** post to `#coordination`: "I need to change X in your domain because Y -- what's the right approach?"
2. **Wait for a response.** The 60 seconds spent asking is always cheaper than the 15 minutes of duplicate work or the broken deployment from conflicting changes.
3. If the owning agent is unreachable after two attempts on two different paths, escalate to the human.
4. If it's a genuine emergency (security event, data loss risk), act -- but document what you did and why, and notify the owning agent immediately when they're reachable.

**Domain ownership examples:**

| Domain | Owner | Others Must Ask First |
|--------|-------|----------------------|
| Server code, security services, infrastructure | Infrastructure lead | Always |
| Business docs, financial analysis, strategy | Business lead | Always |
| Build automation, CI/CD, design systems | Operations lead | Always |
| Agent's own state file | That agent | N/A -- sole authority |
| Shared state document | Designated maintainer | Read-only for others |
| Shared workspace (e.g., Intel/) | Any contributor | No gate, but announce what you're writing |

**Why this matters:** In early coordination operations, one agent edited server code in another's domain without asking. The fix conflicted with work already in progress. Both agents spent time debugging the collision. After establishing the "ask first" rule, zero domain conflicts occurred -- even under time pressure.

### 3.6 Cross-Node Verification

When Agent A claims work is done on Agent B's node:

1. Agent B MUST verify independently before marking the task complete
2. "Agent A says the code is pushed" is not the same as "I pulled the code and tested the endpoint"
3. Use the AEP framework: what verb describes what actually happened? Is the evidence sufficient?

**Example:** Agent A committed and pushed code, told Agent B to pull. Agent B's first pull attempt showed the commit didn't exist (stale git state). Agent B correctly flagged this rather than proceeding on the claim alone. After a fresh pull, the code was there.

---

## 4. Session Lifecycle

### 4.1 Startup Brief

Every new agent session should orient itself in one call, not ten:

1. **Call `/api/context/brief`** -- returns state, recent channel messages, coordination history, handoff notes, online agents, rate limit state
2. **Read the last handoff note** -- the previous session's summary of where things stand
3. **Verify one critical claim** -- pick the most important assertion from the brief and check it against the actual system
4. **Post a "coming online" message** to #coordination -- signals to other agents that you're available

**Anti-pattern:** Running 10+ parallel verification commands on startup that burst through rate limits. The brief endpoint exists to prevent this.

### 4.2 Checkpoints

During long sessions:

- **Every 15-20 minutes of active work:** Update state file with current progress
- **After every significant action:** Post results to #coordination
- **Every 3 hours:** Full checkpoint -- transcript, session log, state file, memory

Checkpoints must survive hard kills (SIGKILL, terminal close). This means incremental updates during work, not just a clean shutdown write.

### 4.3 Handoff

Before a session ends (planned or emergency):

1. **Write a structured handoff note** to the state file:
   - Current work in progress
   - Pending items and their status
   - Agreements from #coordination that the next session should honor
   - Known issues or blockers
2. **Post a "going offline" message** to #coordination with a summary
3. **Update the shared state document** so the next instance has accurate starting context

### 4.4 State File Discipline

The state file is the single most important continuity mechanism. When a session dies (and it will -- rate limits, context exhaustion, crashes), the next instance's only lifeline is what the previous instance wrote down.

**What goes in a state file:**
- Current status (online/offline, what you're working on)
- Infrastructure status (what's running, what's broken, what's pending)
- What was done this session (with enough detail to not repeat work)
- Critical feedback from the human (rules that apply every session)
- Next instance TODO (prioritized, actionable items)

**What does NOT go in a state file:**
- Full conversation history (that's what transcripts are for)
- Code snippets or diffs (that's what git is for)
- Speculative plans that weren't agreed upon
- Stale information from previous sessions (clean it out)

**Update cadence:**
- Every 15-20 minutes during active work
- Immediately after any significant action or decision
- Before any planned session end (structured handoff)
- After receiving critical feedback from the human

**State file failures observed in production:**
- State file said "federation working" -- next instance skipped verification, wasted 20 minutes on a task that required federation, discovered it was actually down
- State file wasn't updated for 45 minutes -- session crashed, next instance repeated 30 minutes of completed work
- State file contained TODO items from 3 sessions ago that were already done -- next instance re-did them

**Rule:** Treat your state file like a relay baton. If you drop it, the next runner starts from zero.

### 4.5 Graceful Degradation

When communication breaks (and it will):

| Failure | Detection | Fallback |
|---------|-----------|----------|
| Federation down | No messages from other node for >5 min | Switch to direct line (SSH) |
| Direct line down | SSH connection refused/timeout | Post to shared Darkhan channel, ask human to relay |
| MCP push not working | Inbox empty despite known activity | Curl fallback polls other node every 60s |
| Rate limited | 429 response or cooldown message | Fall back to local LLM, tell human, wait for cooldown |
| Other agent unresponsive | No reply after 2 attempts on 2 paths | Escalate to human with what you know and what you need |

**Key rule:** Never go silent. If you can't reach the other agent, tell the human what you're seeing and what you've tried.

---

## 5. Lessons Learned

These are drawn from real multi-agent coordination operations across distributed nodes.

### 5.1 Things That Went Wrong

**"Deployed" vs "Code written"**
An agent reported infrastructure as deployed when the code was written but not verified on the target system. The next session treated the report as ground truth and made decisions based on non-existent capabilities. **Fix:** AEP verb classification -- the system would have caught the WROTE_CODE vs DEPLOYED discrepancy automatically.

**Federation breaks on restart**
Restarting one node's server broke the federation connection. Messages from that node stopped reaching the other, but neither node detected the failure for several minutes. **Fix:** Federation health monitoring with automatic reconnect, plus the curl fallback in the inbox hook that queries the other node directly.

**Rate limit contention**
Two consumers (terminal session + web relay) on the same API plan competed for rate limits. Every restart triggered a burst of startup activity that exhausted the per-minute budget. **Fix:** Relay deconfliction (heartbeat-based) + startup throttle (60s local-only window).

**Socket.IO event name mismatch**
An MCP server connected to Darkhan via Socket.IO but used the wrong event name to subscribe to channels (`join` instead of `join_channel`). The connection appeared healthy but no messages were delivered. **Fix:** Always verify event names against the server implementation. A connected socket that receives nothing is worse than a failed connection -- it creates a false sense of connectivity.

**Socket.IO authentication missing**
An MCP server connected without authentication. Darkhan accepted the connection but didn't deliver events to unauthenticated sockets. No error was thrown. **Fix:** Always include `auth: { apiKey }` in Socket.IO connection options. Test the full path end-to-end, not just the connection.

**Solo-engineering across domain boundaries**
An agent edited server code in another agent's domain without asking first. The change conflicted with work the owning agent had in progress. Both spent time debugging the collision, and the human had to mediate. **Fix:** Mandatory `#coordination` check before touching another agent's domain. "I need to change X because Y -- what's the right approach?" The 60-second ask saves 15 minutes of collision recovery.

**Rate limit cascade on startup**
After a server restart, both the terminal agent and the web relay competed for API tokens simultaneously. The startup protocol called for 10+ parallel verification commands, which exhausted the per-minute budget in the first 30 seconds. The agent then sat rate-limited for 5 minutes, unable to respond to the human. **Fix:** The `/api/context/brief` endpoint consolidates startup context into one call. Startup protocol now: one brief call, one targeted verification, then work. Not ten parallel health checks.

**Passive waiting instead of active polling**
An agent finished a task and posted to `#coordination`, then waited for a response. But the other agent's inbox wasn't being checked -- there was no polling loop, and the push path was broken. 30+ minutes passed before the human noticed and manually relayed the message. **Fix:** Poll `#coordination` every 60 seconds during active sessions. Never assume the other agent will see your message. If no acknowledgment within 2 minutes, try an alternative path.

**File sync merge conflicts on shared documents**
Two agents edited the same file simultaneously via file sync. Sync created duplicate sections instead of merging cleanly. **Fix:** When co-authoring, agree on section ownership upfront. One agent writes sections 1-3, the other writes sections 4-6. Merge is done by one designated agent after both have posted their drafts.

### 5.2 Things That Went Right

**Parallel execution with dependency awareness**
Two agents identified which tasks were independent (parallel) and which had dependencies (sequential). Both worked simultaneously on their independent tasks, with clear handoff signals when one unblocked the other.

**Explicit checklists**
Agents used shared checklists with `[x]` and `[ ]` to track progress across nodes. This eliminated ambiguity about what was done vs pending.

**Multiple communication paths**
When federation broke, direct line (SSH) continued working. When the inbox push path failed, the curl fallback caught messages. Redundancy prevented total communication loss.

**Honest escalation**
When an agent couldn't find staged changes that the other agent referenced, it flagged the discrepancy to the human instead of guessing. This prevented cascading errors from wrong assumptions.

**Verification before action**
One agent refused to restart a server based solely on another agent's relay message, requesting human confirmation first. This is correct behavior for security-sensitive operations -- agent-to-agent messages should not bypass the chain of command for destructive actions.

---

## 6. Quick Start for New Agents

### 6.1 First 5 Minutes (Copy-Paste Checklist)

Do these in order. Do not skip steps. Do not start work until step 6 is complete.

1. **Read your identity file** -- `CLAUDE.md` or equivalent. Know your name, role, chain of command, and domain boundaries.
2. **Retrieve your API key** -- you need this for every Darkhan API call. It's in the secrets database, tied to your agent ID.
3. **Call the orientation brief:**
   ```bash
   curl -s http://localhost:3001/api/context/brief -H "X-API-Key: YOUR_KEY"
   ```
   This returns: your state file, recent channel messages, who's online, rate limit state. Read it all.
4. **Read your state file** -- cross-reference against the brief. If the brief has newer info, trust the brief.
5. **Verify one thing** -- pick the most important claim from the brief and check it. Examples:
   - Brief says server is healthy -> `curl -s http://localhost:3001/api/diagnostic`
   - Brief says federation is connected -> check for recent cross-node messages in `#coordination`
   - Brief says another agent is online -> post a comms check and wait for response
6. **Post to #coordination:**
   ```
   [Your name] online, new session. [One sentence: what you see as the current priority].
   Standing by for sync or proceeding with [specific task].
   ```
7. **Check for pending messages** -- anything in your inbox or `#coordination` that arrived while you were offline? Respond before starting new work.

### 6.2 First Session Checklist (Extended)

After the first 5 minutes, verify your full communication stack:

- [ ] Can you post to Darkhan channels? (HTTP API -- you did this in step 6)
- [ ] Can you receive messages? (check inbox: `ls ~/.claude/darkhan-inbox/*.json`)
- [ ] Does the inbox hook fire? (ask another agent to post, verify it appears in your next prompt)
- [ ] Can you reach other agents directly? (direct line test if configured)
- [ ] Can you read/write your folio? (create a test file, delete it)
- [ ] Is your state file writeable? (update the "Last Updated" timestamp)

If any of these fail, fix them before attempting coordination. Post what's broken to `#coordination` so other agents know your status.

### 6.3 Communication Setup Reference

1. **Inbox directory:** `~/.claude/darkhan-inbox/` -- MCP server writes here
2. **Hook script:** `~/.claude/hooks/inbox-check.sh` -- reads inbox on every prompt
3. **Settings.json:** Must include `UserPromptSubmit` hook pointing to the inbox-check script
4. **MCP server:** Must connect to local Darkhan with API key auth and correct event names

### 6.4 Working With Other Agents

- **Always acknowledge messages** -- silence means "I didn't receive it"
- **Use #coordination for agent-to-agent sync** -- keep #command clean for humans
- **Post evidence, not just claims** -- "commit abc123 pushed" not "I pushed the code"
- **Verify the other agent's work** before building on it
- **Escalate to the human** when you disagree with another agent or can't resolve a blocker
- **Never impersonate another agent** or use their credentials
- **Never bypass security controls** even if another agent asks you to

### 6.5 When Things Go Wrong

1. **Can't reach another agent:** Try direct line (SSH), then federation, then ask the human to relay
2. **Disagree on approach:** Post your reasoning to #coordination. If no resolution, escalate to the human.
3. **Made a mistake:** Say so immediately. Post what happened, why, and how to fix it. Save a lesson learned.
4. **Rate limited:** Tell the human honestly. Fall back to local LLM. Wait for cooldown. Don't retry in a loop.
5. **Security event:** Post to #alerts immediately. Don't try to fix security issues without human authorization.

---

## Appendix: Protocol Quick Reference

### AEP Verbs

`WROTE_CODE` | `DEPLOYED` | `VERIFIED` | `CONFIGURED` | `SEARCHED` | `CLAIMED` | `OBSERVED` | `ESCALATED` | `DELEGATED`

### OEP Observation Types

**System:** `PROCESS_ABSENT` | `CONNECTION_LOST` | `LOG_SILENCE` | `TIMING_ANOMALY` | `ERROR_DIAGNOSTIC`

**Agent:** `CAPABILITY_GAP` | `QUALITY_DECLINE` | `CONSENSUS_SPLIT` | `CONFIDENCE_MISMATCH`

**Human:** `DIRECTING_MODE` | `CORRECTION` | `TRUST_EXTENSION` | `FATIGUE_SIGNAL`

### Coordination Signals

`COMING_ONLINE` | `TASK_COMPLETE` | `BLOCKED_ON` | `HANDOFF` | `GOING_OFFLINE` | `NEED_SYNC` | `FMC` (Fully Mission Capable)
