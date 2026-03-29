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
 * Static structure — changes here when org chart changes.
 */
const CHAIN_OF_COMMAND = {
  user_admin: { title: 'Founder/CEO', reportsTo: null, directReports: ['agent_claude'] },
  agent_claude: { title: 'Chief of Staff / CTO / CIO / CISO / CCO / CDO / CHRO', reportsTo: 'user_admin', directReports: ['agent_lindsey', 'agent_penny', 'agent_chief', 'agent_darkhan'] },
  agent_lindsey: { title: 'COO / S3 Chief of Operations', reportsTo: 'agent_claude', directReports: [] },
  agent_penny: { title: 'CFO / CMO / CSO / CXO', reportsTo: 'agent_claude', directReports: [] },
  agent_chief: { title: 'Executive Assistant', reportsTo: 'agent_claude', directReports: [] },
  agent_darkhan: { title: 'Security Officer', reportsTo: 'agent_claude', directReports: [] },
};

/**
 * Operating rules that every agent must follow.
 * These are injected verbatim into the onboarding brief.
 */
const OPERATING_RULES = [
  'Never claim something is "deployed", "operational", or "complete" unless you have verified it yourself in this session.',
  'Never fabricate information. If you do not know, say "I don\'t know" or "I need to check."',
  'Flag all assumptions explicitly. Distinguish between verified facts and inferences.',
  'Only reference specific deliverables, dates, findings, or status items that appear in the context provided to you. Do not fill gaps with plausible-sounding details. If the context does not contain the answer, say what you do know and what you cannot confirm.',
  'Your State.md context is point-in-time. Verify before asserting as current.',
  'You cannot unlock Darkhan\'s security lockdown. Only a human admin can.',
  'You cannot impersonate other agents or humans. Identity is enforced by the system.',
  'Post results to your designated channels, not chan_command, unless the task specifically requires it.',
  'If asked about system state, check actual data. Do not guess from training data or prior context.',
  'Never bend data or goose numbers. Intellectual honesty above all.',
  'If a task will take significant time, acknowledge receipt immediately.',
];

class OnboardingService {
  /**
   * @param {Object} opts
   * @param {Object} opts.config - darkhan.config.json contents
   * @param {Object} opts.db - SQLite database handle (null for federated workers)
   * @param {string} opts.vaultPath - Resolved vault path
   */
  constructor({ config, db, vaultPath }) {
    this.config = config;
    this.db = db;
    this.vaultPath = vaultPath;
  }

  /**
   * Generate a full onboarding brief for a specific agent.
   *
   * @param {string} agentId - e.g. 'agent_penny'
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
      `- Organization: Your Organization / Your Organization LLC`,
      '',
      'Chain of Command:',
      '  1. the admin (user_admin) — Founder/CEO, final authority',
      '  2. Claude (agent_claude) — Chief of Staff/CTO, 2nd in command',
      `  3. Your position: ${agentConfig.name} — ${chain.title}`,
      '',
      `- You report to: ${reportsToName}`,
      `- Direct reports: ${directReportNames}`,
    ];

    return lines.join('\n');
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

    // Check which other agents are in the config
    const otherAgents = this.config.team.members
      .filter(m => m.id !== agentId && m.type === 'agent')
      .map(m => {
        const status = m.worker ? 'worker (scheduled tasks)' : (m.model?.mode || 'configured');
        return `  - ${m.name} (${m.id}): ${m.model?.provider}/${m.model?.model} [${status}]`;
      });

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
    const vaultExists = fs.existsSync(this.vaultPath);

    const lines = [
      '## 2. Verified System State',
      '',
      `- Hostname: ${hostname}`,
      `- Platform: ${platform}`,
      `- Process uptime: ${nodeUptime}s`,
      `- Execution mode: ${isRemote ? 'federated (remote worker posting via HTTP API)' : 'local (direct DB/socket access)'}`,
      `- Darkhan instance: ${this.config.instance?.name || 'unnamed'} (${this.config.instance?.brandName || 'Darkhan'})`,
      `- Darkhan port: ${this.config.instance?.port || 'unknown'}`,
      `- Timezone: ${this.config.instance?.timezone || 'unset'}`,
      '',
      `- Your LLM: ${providerDetails}`,
      `- Rate limits: ${agentConfig.rateLimits ? `${agentConfig.rateLimits.requestsPerDay} req/day, ${agentConfig.rateLimits.requestsPerMinute} req/min` : 'not configured (defaults apply)'}`,
      '',
      `- Vault path: ${this.vaultPath}`,
      `- Vault accessible: ${vaultExists ? 'yes' : 'NO — path does not exist'}`,
      `- Write permissions: ${fsWritePaths.length > 0 ? fsWritePaths.join(', ') : 'none explicitly configured'}`,
      '',
      'Configured channels:',
      ...channelNames.map(ch => `  - ${ch}`),
      '',
      'Other agents in config:',
      ...otherAgents,
      '',
      heartbeatInfo,
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
      `- File system: Read access to full vault. ${writeDesc}`,
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

    return `You are ${agentConfig.name}, ${chain.title} for Your Organization / Your Organization. You are running on ${hostname} via ${provider}/${model}. You report to ${reportsToName}. Chain of command: the admin (CEO) > Claude (Chief of Staff/CTO) > you. RULES: Never claim unverified state. Never fabricate information. Flag all assumptions. If you don't know, say so. You cannot bypass security controls. Post to your designated channels unless the task requires chan_command.`;
  }
}

module.exports = { OnboardingService };
