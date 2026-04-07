/**
 * Darkhan — Intelligence Gate (v1)
 *
 * Four-layer message classification that determines the cheapest capable
 * processing layer for every message. Replaces scattered classification
 * logic with a single, config-driven module.
 *
 * Layers:
 *   0 — Direct: code only, zero LLM (worker listeners, acks, heartbeats)
 *   1 — Local LLM: node-llama-cpp on each node, zero cloud cost
 *   2 — Mid-tier cloud: Sonnet 4.6 / Gemini 2.5 Flash (separate rate pool)
 *   3 — Deep cloud: Opus 4.6 (explicit request only)
 *
 * Design principle: agent-to-agent coordination NEVER touches cloud APIs.
 * Each agent has their own Max plan — coordination should cost $0 on all sides.
 * Cloud calls are reserved for genuine deep work requested by humans or
 * escalation chains.
 *
 * @module intelligence-gate
 */

// Layer 0 patterns: zero LLM needed, handled by code/workers
const LAYER_0_PATTERNS = [
  /^comms?\s*check$/i,
  /^team,?\s*comms?\s*check$/i,
  /^ping$/i,
  /^(ack|copy|roger|received|acknowledged?)[\s!.,]*$/i,
  /^(yes|no|yep|nope|sure|absolutely|negative|affirmative)[\s!.,]*$/i,
  /^(ok|okay|got\s*it|understood)[\s!.,]*$/i,
  /^thanks?(\s+you)?[\s!.,]*$/i,
  /^status$/i,
  /^heartbeat:/i,
];

// Layer 1 patterns: local LLM can handle these
const LAYER_1_PATTERNS = [
  /^(hey|hi|hello|good\s*(morning|afternoon|evening))[\s!.,?]*$/i,
  /^are\s+you\s+(online|there|up|alive|awake)\??$/i,
  /^what\s+(time|day)\s+is\s+it\??$/i,
  /^what('?s| is)\s+(the\s+)?date\??$/i,
  /^how('?s| is)\s+(it\s+going|everything|things)\??$/i,
  /^what('?s| is)\s+your\s+status\??$/i,
];

// Layer 3 explicit triggers: always go to Opus
const LAYER_3_PREFIXES = [
  '/deep ',
  '/opus ',
  '/claude ',
  '@claude',
];

// Strong relay indicators: single match triggers Layer 3
const STRONG_INDICATORS = [
  'deploy', 'implement', 'dispatch', 'update state',
  'red team', 'checkpoint', 'transcript', 'session log',
  'debug', 'ssh',
];

// Weak relay indicators: need 2+ matches to trigger Layer 3
const WEAK_INDICATORS = [
  'build', 'create', 'write', 'draft',
  'analyze', 'investigate',
  'edit', 'code', 'script', 'fix',
  'restart', 'kill', 'install', 'configure',
  'how should', 'what should', 'should we', 'do you think',
  "what's the plan", "what's next", 'priority', 'recommend',
  'strategy', 'approach', 'architecture', 'design',
];

/**
 * Classify a message into the cheapest capable processing layer.
 *
 * @param {Object} message
 * @param {string} message.body - Message content
 * @param {string} message.fromUser - Sender ID (e.g., 'user_adrian', 'agent_penny@omc-node1')
 * @param {string} message.channelId - Channel ID
 * @param {Object} context
 * @param {string[]} context.humanUsers - List of human user IDs
 * @param {string} context.leadAgentId - Lead agent ID (e.g., 'agent_claude')
 * @param {Object} [context.gateConfig] - intelligenceGate config from darkhan.config.json
 * @returns {{ layer: number, reason: string, tier: string }}
 */
function classifyForLayer(message, context) {
  const { body, fromUser, channelId } = message;
  const { humanUsers = [], leadAgentId = 'agent_claude', gateConfig = {} } = context;
  const lowerBody = (body || '').trim().toLowerCase();
  const isHuman = humanUsers.includes(fromUser);
  const isAgent = !isHuman && fromUser !== 'system_heartbeat';
  const isFederated = fromUser.includes('@');
  const baseAgentId = fromUser.split('@')[0]; // Strip federation suffix

  // --- Layer 3 explicit triggers (always honored) ---
  for (const prefix of LAYER_3_PREFIXES) {
    if (lowerBody.startsWith(prefix)) {
      return { layer: 3, reason: `explicit prefix: ${prefix.trim()}`, tier: 'claude_relay' };
    }
  }

  // --- Heartbeats: Layer 0 always ---
  if (fromUser === 'system_heartbeat' || (fromUser === leadAgentId && lowerBody.startsWith('heartbeat:'))) {
    return { layer: 0, reason: 'heartbeat', tier: 'heartbeat_log' };
  }

  // --- Force local: /quick, /fast, /local, @darkhan ---
  if (lowerBody.startsWith('/quick ') || lowerBody.startsWith('/fast ') || lowerBody.startsWith('/local ')) {
    return { layer: 1, reason: 'explicit local prefix', tier: 'local_llm' };
  }
  if (lowerBody.startsWith('@agent_darkhan') || lowerBody.startsWith('@darkhan')) {
    return { layer: 1, reason: '@darkhan mention', tier: 'local_llm' };
  }

  // --- Agent messages: Layer 0-1 unless explicitly escalating ---
  // Core principle: agent-to-agent coordination never touches cloud APIs
  if (isAgent) {
    // Check for explicit escalation markers
    if (lowerBody.includes('@claude') || body.includes('[NEEDS_CLAUDE]') || body.includes('[NEEDS_ESCALATION]')) {
      return { layer: 3, reason: 'agent explicit escalation', tier: 'claude_relay' };
    }

    // Check agent's configured maxLayer
    const agentMaxLayer = gateConfig?.agentToAgent?.maxLayer ?? 1;
    const agentConfig = gateConfig?.localWorkers?.[baseAgentId];
    const maxLayer = agentConfig?.maxLayer ?? agentMaxLayer;

    // Check Layer 0 patterns
    for (const pattern of LAYER_0_PATTERNS) {
      if (pattern.test(lowerBody)) {
        return { layer: 0, reason: 'agent Layer 0 pattern', tier: 'heartbeat_log' };
      }
    }

    // Default: agent messages go to local LLM (Layer 1) max
    return {
      layer: Math.min(1, maxLayer),
      reason: 'agent-to-agent coordination (Layer 0-1)',
      tier: 'local_llm',
    };
  }

  // --- Human messages below this point ---

  // Layer 0 patterns
  for (const pattern of LAYER_0_PATTERNS) {
    if (pattern.test(lowerBody)) {
      return { layer: 0, reason: 'Layer 0 pattern match', tier: 'heartbeat_log' };
    }
  }

  // Layer 1 patterns
  for (const pattern of LAYER_1_PATTERNS) {
    if (pattern.test(lowerBody)) {
      return { layer: 1, reason: 'Layer 1 pattern match (greeting/status)', tier: 'local_llm' };
    }
  }

  // Strong indicators: single match → Layer 3
  for (const indicator of STRONG_INDICATORS) {
    if (lowerBody.includes(indicator)) {
      return { layer: 3, reason: `strong indicator: "${indicator}"`, tier: 'claude_relay' };
    }
  }

  // Weak indicators: need 2+ matches → Layer 3, 1 match → Layer 2
  let weakMatches = 0;
  let firstMatch = '';
  for (const indicator of WEAK_INDICATORS) {
    if (lowerBody.includes(indicator)) {
      weakMatches++;
      if (!firstMatch) firstMatch = indicator;
    }
  }
  if (weakMatches >= 2) {
    return { layer: 3, reason: `${weakMatches} weak indicators (compound complexity)`, tier: 'claude_relay' };
  }
  if (weakMatches === 1) {
    return { layer: 2, reason: `single weak indicator: "${firstMatch}" (mid-tier)`, tier: 'local_llm' };
  }

  // Long messages: >1000 chars → Layer 2 (local LLM can try, escalate if needed)
  if (body.length > 1000) {
    return { layer: 2, reason: 'long message (>1000 chars)', tier: 'local_llm' };
  }

  // Default → Layer 1 (local LLM)
  return { layer: 1, reason: 'default classification', tier: 'local_llm' };
}

/**
 * Check if a message should be duplicated to #command as a cross-channel notification.
 * Only Layer 2+ messages get duplicated — Layer 0-1 stay in their channel.
 *
 * @param {Object} message
 * @param {Object} context
 * @returns {boolean}
 */
function shouldNotifyCommand(message, context) {
  const { layer } = classifyForLayer(message, context);
  return layer >= 2;
}

/**
 * Get a human-readable description of a layer for display.
 *
 * @param {number} layer
 * @returns {string}
 */
function layerDescription(layer) {
  switch (layer) {
    case 0: return 'Layer 0 (direct — zero LLM)';
    case 1: return 'Layer 1 (local LLM — zero cloud cost)';
    case 2: return 'Layer 2 (mid-tier cloud — Sonnet/Gemini)';
    case 3: return 'Layer 3 (deep cloud — Opus)';
    default: return `Layer ${layer} (unknown)`;
  }
}

module.exports = {
  classifyForLayer,
  shouldNotifyCommand,
  layerDescription,
  // Export for testing
  LAYER_0_PATTERNS,
  LAYER_1_PATTERNS,
  LAYER_3_PREFIXES,
  STRONG_INDICATORS,
  WEAK_INDICATORS,
};
