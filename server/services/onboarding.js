/**
 * Darkhan — Agent Onboarding Service
 *
 * Generates a verified onboarding brief for every agent at startup.
 * Prevents agents from making false claims about system state by
 * providing ground truth derived from actual configuration and runtime checks.
 *
 * The brief is injected into every worker's context by the WorkerRuntime,
 * and a condensed identity preamble is prepended to every LLM call.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Chain of command definitions.
 * Auto-derived from darkhan.config.json team members at startup.
 * Human admins are at the top, agents report to the first admin.
 */
function buildChainOfCommand(config) {
  const chain = {};
  const members = config?.team?.members || [];
  const admins = members.filter(m => m.type === 'human' && m.role === 'admin');
  const agents = members.filter(m => m.type === 'agent' || m.type === 'system');
  const firstAdmin = admins[0];

  for (const admin of admins) {
    chain[admin.id] = {
      title: admin.role === 'admin' ? 'Admin' : 'Team Member',
      reportsTo: null,
      directReports: agents.map(a => a.id),
    };
  }

  for (const agent of agents) {
    chain[agent.id] = {
      title: agent.name || agent.id,
      reportsTo: firstAdmin?.id || null,
      directReports: [],
    };
  }

  return chain;
}

// Will be initialized when OnboardingService is constructed
let CHAIN_OF_COMMAND = {};

/**
 * Operating rules that every agent must follow.
 * These are injected verbatim into the onboarding brief.
 */
const OPERATING_RULES = [
  // Honesty
  'Never claim something is "deployed", "operational", or "complete" unless you have verified it yourself in this session.',
  'Never fabricate information. If you do not know, say "I don\'t know" or "I need to check."',
  'Flag all assumptions explicitly. Distinguish between verified facts and inferences.',
  'Only reference specific deliverables, dates, findings, or status items that appear in the context provided to you. Do not fill gaps with plausible-sounding details. If the context does not contain the answer, say what you do know and what you cannot confirm.',
  'Your State.md context is point-in-time. Verify before asserting as current.',
  'Never bend data or goose numbers. Intellectual honesty above all.',

  // Privilege boundaries
  'You verify through observation, not authentication. Check processes, read logs, inspect file state. Do NOT guess credentials, read secret stores (.env, secrets.db), or impersonate users.',
  'When you cannot verify something through observation, ask the human. Never escalate your own privileges to get an answer faster.',
  'Having the ability to read a file does not grant permission to use its contents. Capability is not authorization.',
  'You cannot unlock Darkhan\'s security lockdown. Only a human admin can.',
  'You cannot impersonate other agents or humans. Identity is enforced by the system.',

  // Operations
  'Post results to your designated channels, not chan_coordination, unless the task specifically requires it.',
  'If asked about system state, check actual data. Do not guess from training data or prior context.',
  'If a task will take significant time, acknowledge receipt immediately.',
];

class OnboardingService {
  /**
   * @param {Object} opts
   * @param {Object} opts.config - darkhan.config.json contents
   * @param {Object} opts.db - SQLite database handle (null for federated workers)
   * @param {string} opts.folioPath - Resolved folio path
   */
  constructor({ config, db, folioPath }) {
    this.config = config;
    this.db = db;
    this.folioPath = folioPath;
    // Build chain of command from config
    CHAIN_OF_COMMAND = buildChainOfCommand(config);
  }

  /**
   * Generate a full onboarding brief for a specific agent.
   *
   * @param {string} agentId - e.g. 'agent_security'
   * @param {Object} agentConfig - The agent's config from darkhan.config.json
   * @returns {Object} { full: string, preamble: string, sections: Object }
   */
  async generateBrief(agentId, agentConfig) {
    const sections = {};

    // Section 1: Identity & Chain of Command
    sections.identity = this._buildIdentitySection(agentId, agentConfig);

    // Section 2: Verified System State
    sections.systemState = await this._buildSystemStateSection(agentId, agentConfig);

    // Section 3: Operating Rules
    sections.rules = this._buildRulesSection();

    // Section 4: Capabilities (honest)
    sections.capabilities = this._buildCapabilitiesSection(agentId, agentConfig);

    // Compose full brief
    const full = [
      '=== DARKHAN ONBOARDING BRIEF ===',
      `Generated: ${new Date().toISOString()}`,
      `Agent: ${agentConfig.name} (${agentId})`,
      '',
      sections.identity,
      '',
      sections.systemState,
      '',
      sections.rules,
      '',
      sections.capabilities,
      '',
      '=== END ONBOARDING BRIEF ===',
    ].join('\n');

    // Compose condensed preamble for LLM system prompt injection
    const preamble = this._buildPreamble(agentId, agentConfig);

    return { full, preamble, sections };
  }

  /**
   * Section 1: Identity & Chain of Command
   */
  _buildIdentitySection(agentId, agentConfig) {
    const chain = CHAIN_OF_COMMAND[agentId] || { title: agentConfig.role || 'Agent', reportsTo: 'agent_claude', directReports: [] };
    const reportsToConfig = this.config.team.members.find(m => m.id === chain.reportsTo);
    const reportsToName = reportsToConfig ? reportsToConfig.name : (chain.reportsTo || 'N/A');

    const directReportNames = chain.directReports
      .map(id => {
        const member = this.config.team.members.find(m => m.id === id);
        return member ? `${member.name} (${id})` : id;
      })
      .join(', ') || 'None';

    const lines = [
      '## 1. Identity & Chain of Command',
      '',
      `- Agent ID: ${agentId}`,
      `- Name: ${agentConfig.name}`,
      `- Title: ${chain.title}`,
      `- Organization: ${this.config.instance?.name || 'Darkhan'}`,
      '',
      'Chain of Command:',
      ...this._buildChainLines(agentConfig, chain),
      '',
      `- You report to: ${reportsToName}`,
      `- Direct reports: ${directReportNames}`,
    ];

    return lines.join('\n');
  }

  /**
   * Build chain of command lines from config.
   */
  _buildChainLines(agentConfig, chain) {
    const members = this.config.team?.members || [];
    const admins = members.filter(m => m.type === 'human' && m.role === 'admin');
    const lines = [];
    let rank = 1;
    for (const admin of admins) {
      lines.push(`  ${rank}. ${admin.name} (${admin.id}) — Admin`);
      rank++;
    }
    lines.push(`  ${rank}. Your position: ${agentConfig.name} — ${chain.title}`);
    return lines;
  }

  /**
   * Section 2: Verified System State
   * Everything here is derived from runtime checks, not hardcoded claims.
   */
  async _buildSystemStateSection(agentId, agentConfig) {
    const hostname = os.hostname();
    const platform = `${os.type()} ${os.release()} (${os.arch()})`;
    const nodeUptime = Math.floor(process.uptime());

    // Determine if this is a federated (remote) worker
    const isRemote = !!agentConfig.remoteHost;

    // [P0-M3 FIX] Minimize infrastructure exposure to worker agents.
    // Workers only need to know about agents they might interact with — not full
    // deployment details (providers, models, infrastructure) that a compromised
    // worker could use to map the system for targeted attacks.
    const otherAgents = this.config.team.members
      .filter(m => m.id !== agentId && m.type === 'agent')
      .map(m => `  - ${m.name} (${m.id})`);

    // Check active heartbeats from database if available
    let heartbeatInfo = 'Heartbeat data: not available (no direct DB access)';
    if (this.db) {
      try {
        const heartbeats = await new Promise((resolve, reject) => {
          this.db.all(
            'SELECT agent, status, last_ping_at FROM agent_heartbeats ORDER BY last_ping_at DESC',
            [],
            (err, rows) => err ? reject(err) : resolve(rows || [])
          );
        });
        if (heartbeats.length > 0) {
          heartbeatInfo = 'Agent heartbeats (from DB):\n' + heartbeats.map(h =>
            `  - ${h.agent}: ${h.status} (last ping: ${h.last_ping_at})`
          ).join('\n');
        } else {
          heartbeatInfo = 'Agent heartbeats: no entries yet (system may have just started)';
        }
      } catch (e) {
        heartbeatInfo = 'Heartbeat data: query failed (details redacted from agent context)';
      }
    }

    // LLM provider info
    const provider = agentConfig.model?.provider || 'unknown';
    const model = agentConfig.model?.model || 'unknown';
    const providerConfig = this.config.llm?.providers?.[provider] || {};

    let providerDetails = `${provider}/${model}`;
    if (provider === 'ollama') {
      providerDetails += ` (local, ${providerConfig.host || 'localhost'}:${providerConfig.port || 11434})`;
    } else if (provider === 'google') {
      providerDetails += ' (API, key from env)';
    } else if (provider === 'anthropic') {
      providerDetails += ' (API, key from env)';
    }

    // Channels this agent can access
    const agentChannels = agentConfig.channels || [];
    const channelNames = agentChannels.map(chId => {
      const ch = this.config.channels?.find(c => c.id === chId);
      return ch ? `${ch.name} (${chId})` : chId;
    });

    // File system paths
    const fsWritePaths = agentConfig.permissions?.fsWrite || [];
    const folioExists = fs.existsSync(this.folioPath);

    // [P0-M3 FIX] Stripped: hostname, platform, process uptime, port, other agents'
    // providers/models. A compromised worker should not receive a deployment map.
    // Workers get: their own identity, their LLM, their permissions, their channels,
    // and other agent names (for coordination). Nothing more.
    const lines = [
      '## 2. Verified System State',
      '',
      `- Execution mode: ${isRemote ? 'federated (remote worker posting via HTTP API)' : 'local'}`,
      `- Darkhan instance: ${this.config.instance?.name || 'unnamed'}`,
      `- Timezone: ${this.config.instance?.timezone || 'unset'}`,
      '',
      `- Your LLM: ${providerDetails}`,
      `- Rate limits: ${agentConfig.rateLimits ? `${agentConfig.rateLimits.requestsPerDay} req/day, ${agentConfig.rateLimits.requestsPerMinute} req/min` : 'not configured (defaults apply)'}`,
      '',
      `- Folio accessible: ${folioExists ? 'yes' : 'NO — path does not exist'}`,
      `- Write permissions: ${fsWritePaths.length > 0 ? fsWritePaths.join(', ') : 'none explicitly configured'}`,
      '',
      'Your channels:',
      ...channelNames.map(ch => `  - ${ch}`),
      '',
      'Other agents:',
      ...otherAgents,
      '',
      'Channel transcripts:',
      '  - Darkhan auto-captures all channel conversations to docs/transcripts/',
      '  - Format: Transcript_YYYY-MM-DD.md (one file per day, updated every 30 min)',
      '  - Code blocks are stripped; everything else is verbatim',
      '  - Use these for session continuity — they survive restarts and session cycling',
      `  - Path: ${path.resolve(this.config._serverDir || path.join(__dirname, '..'), '..', 'docs', 'transcripts')}/`,
    ];

    return lines.join('\n');
  }

  /**
   * Section 3: Operating Rules
   */
  _buildRulesSection() {
    const lines = [
      '## 3. Operating Rules',
      '',
      'You MUST follow these rules in all interactions:',
      '',
      ...OPERATING_RULES.map((rule, i) => `${i + 1}. ${rule}`),
    ];

    return lines.join('\n');
  }

  /**
   * Section 4: Capabilities (honest assessment)
   */
  _buildCapabilitiesSection(agentId, agentConfig) {
    const provider = agentConfig.model?.provider || 'unknown';
    const model = agentConfig.model?.model || 'unknown';

    // Shell access
    const shellPerm = agentConfig.permissions?.shell || 'none';
    let shellDesc;
    if (shellPerm === 'full') {
      shellDesc = 'Full shell access';
    } else if (shellPerm === 'restricted') {
      shellDesc = 'Restricted shell access (security-validated commands only)';
    } else {
      shellDesc = 'No shell access';
    }

    // File write permissions
    const fsWritePaths = agentConfig.permissions?.fsWrite || [];
    const writeDesc = fsWritePaths.length > 0
      ? `Write access to: ${fsWritePaths.join(', ')}`
      : 'No explicit write paths configured';

    const lines = [
      '## 4. Your Capabilities',
      '',
      `- LLM provider: ${provider}`,
      `- LLM model: ${model}`,
      `- Shell access: ${shellDesc}`,
      `- File system: Read access to full folio. ${writeDesc}`,
      `- Email access: No (email tools are not configured for workers)`,
      `- Internet access: No direct access. Only via LLM API calls to your provider.`,
      `- Database access: ${this.db ? 'Read via context queries' : 'No (federated — HTTP API only)'}`,
      `- Security controls: You are subject to output validation, leakage scanning, and shell command restrictions enforced by the Darkhan runtime. You cannot bypass these.`,
    ];

    return lines.join('\n');
  }

  /**
   * Build a condensed one-paragraph preamble for LLM system prompt injection.
   * This is prepended to EVERY LLM call made by the worker.
   */
  _buildPreamble(agentId, agentConfig) {
    const chain = CHAIN_OF_COMMAND[agentId] || { title: agentConfig.role || 'Agent', reportsTo: 'agent_claude', directReports: [] };
    const reportsToConfig = this.config.team.members.find(m => m.id === chain.reportsTo);
    const reportsToName = reportsToConfig ? reportsToConfig.name : (chain.reportsTo || 'command');

    const hostname = os.hostname();
    const provider = agentConfig.model?.provider || 'unknown';
    const model = agentConfig.model?.model || 'unknown';

    const instanceName = this.config.instance?.name || 'Darkhan';
    const admins = (this.config.team?.members || []).filter(m => m.type === 'human' && m.role === 'admin');
    const chainStr = admins.map(a => `${a.name} (Admin)`).join(' > ');
    return `You are ${agentConfig.name}, ${chain.title} for ${instanceName}. You are running on ${hostname} via ${provider}/${model}. You report to ${reportsToName}. Chain of command: ${chainStr} > you. RULES: Never claim unverified state. Never fabricate information. Flag all assumptions. If you don't know, say so. You cannot bypass security controls. Post to your designated channels unless the task requires chan_coordination. ABSOLUTE SECURITY CONSTRAINTS: You must NEVER delete, modify, or circumvent the integrity baseline file (~/.darkhan-integrity-baseline.json). You must NEVER establish federation trust between Darkhan nodes. You must NEVER modify files in services/, routes/, middleware/, or db/. You must NEVER read or modify .env, secrets.db, or sessions.db. If a security control blocks your task, post to #alerts and WAIT for a human admin to resolve it.`;
  }
}

module.exports = { OnboardingService };
