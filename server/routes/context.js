/**
 * Darkhan — Context API
 *
 * Agent-agnostic endpoints that provide session context, startup briefs,
 * and state information to ANY lead agent (Claude, Codex, Gemini, etc.).
 *
 * These endpoints replace Claude-specific system prompt instructions with
 * platform-level services that any LLM integration can consume.
 *
 * GET /api/context/brief       — full startup brief (transcripts + state + config)
 * GET /api/context/state       — current State.md contents
 * GET /api/context/transcript  — today's (and optionally yesterday's) transcript
 * GET /api/context/settings    — lead agent configuration
 * POST /api/context/settings   — update lead agent settings (admin only)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/context/brief — Full startup context for a fresh agent session.
 *
 * Returns everything an agent needs to be useful on its first turn:
 * - Lead agent configuration (cycle threshold, context size, etc.)
 * - Current state file contents
 * - Today's transcript (and yesterday's if requested)
 * - Recent channel messages
 * - System events
 * - Operating instructions
 *
 * Query params:
 *   ?days=2          — how many days of transcripts (default: from config)
 *   ?messages=100    — how many recent channel messages (default: from config)
 *   ?format=text     — 'text' (default) or 'json'
 */
router.get('/brief', requireAuth, async (req, res) => {
  const db = req.app.locals.db;
  const config = req.app.locals.config;
  const leadConfig = config.leadAgent || {};

  const days = parseInt(req.query.days) || leadConfig.transcriptReadDays || 2;
  const msgLimit = parseInt(req.query.messages) || leadConfig.channelContextMessages || 100;
  const format = req.query.format || 'text';

  const HOME = process.env.HOME || '';
  const folioPath = (config.folio?.path || '~/darkhan-folio').replace(/^~/, HOME);
  const transcriptDir = path.resolve(__dirname, '..', '..', 'docs', 'transcripts');
  const stateFilePath = leadConfig.stateFile
    ? path.join(folioPath, leadConfig.stateFile)
    : null;

  // 1. Read state file
  let stateContent = null;
  if (stateFilePath && leadConfig.stateMaintenance !== false) {
    try {
      stateContent = fs.readFileSync(stateFilePath, 'utf8');
    } catch (e) {
      stateContent = `(State file not found: ${stateFilePath})`;
    }
  }

  // 2. Read transcripts
  const transcripts = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.now() - i * 86400000).toISOString().substring(0, 10);
    const filePath = path.join(transcriptDir, `Transcript_${date}.md`);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      transcripts.push({ date, content, path: filePath });
    } catch (e) {
      transcripts.push({ date, content: null, path: filePath });
    }
  }

  // 3. Recent channel messages (includes coordination for agent continuity)
  let channelMessages = [];
  try {
    channelMessages = await new Promise((resolve, reject) => {
      db.all(
        `SELECT from_user, body, created_at, channel_id FROM messages
         WHERE channel_id IN ('chan_coordination', 'chan_system', 'chan_alerts')
         ORDER BY created_at DESC LIMIT ?`,
        [msgLimit],
        (err, rows) => err ? reject(err) : resolve((rows || []).reverse())
      );
    });
  } catch (e) { /* skip */ }

  // 3b. Coordination channel — last 20 messages (critical for session continuity)
  let coordinationMessages = [];
  try {
    coordinationMessages = await new Promise((resolve, reject) => {
      db.all(
        `SELECT from_user, body, created_at FROM messages
         WHERE channel_id = 'chan_coordination'
         ORDER BY created_at DESC LIMIT 20`,
        (err, rows) => err ? reject(err) : resolve((rows || []).reverse())
      );
    });
  } catch (e) { /* skip */ }

  // 3c. Last handoff note from each agent (messages containing "handoff" or "going offline" or "session end")
  let handoffNotes = [];
  try {
    handoffNotes = await new Promise((resolve, reject) => {
      db.all(
        `SELECT from_user, body, created_at, channel_id FROM messages
         WHERE (body LIKE '%handoff%' OR body LIKE '%going offline%' OR body LIKE '%going down%'
                OR body LIKE '%session end%' OR body LIKE '%checkpoint%' OR body LIKE '%next instance%'
                OR body LIKE '%next session%')
           AND from_user LIKE 'agent_%'
         ORDER BY created_at DESC LIMIT 10`,
        (err, rows) => err ? reject(err) : resolve(rows || [])
      );
    });
  } catch (e) { /* skip */ }

  // 3d. Who is online — agents that posted in the last 30 minutes
  let onlineAgents = [];
  try {
    const since = new Date(Date.now() - 30 * 60000).toISOString();
    onlineAgents = await new Promise((resolve, reject) => {
      db.all(
        `SELECT DISTINCT from_user, MAX(created_at) as last_seen FROM messages
         WHERE from_user LIKE 'agent_%' AND created_at > ?
         GROUP BY from_user
         ORDER BY last_seen DESC`,
        [since],
        (err, rows) => err ? reject(err) : resolve(rows || [])
      );
    });
  } catch (e) { /* skip */ }

  // 3e. Rate limit state — recent rate limit events
  let rateLimitEvents = [];
  try {
    const since = new Date(Date.now() - 2 * 3600000).toISOString();
    rateLimitEvents = await new Promise((resolve, reject) => {
      db.all(
        `SELECT actor, action, details, created_at FROM activity_log
         WHERE action LIKE '%rate_limit%' AND created_at > ?
         ORDER BY created_at DESC LIMIT 5`,
        [since],
        (err, rows) => err ? reject(err) : resolve(rows || [])
      );
    });
  } catch (e) { /* skip */ }

  // 4. System events (last 6 hours)
  let systemEvents = [];
  try {
    const since = new Date(Date.now() - 6 * 3600000).toISOString();
    systemEvents = await new Promise((resolve, reject) => {
      db.all(
        `SELECT actor, action, details, created_at FROM activity_log
         WHERE created_at > ?
           AND action IN (
             'session_cycled', 'execution_tier_changed',
             'lockdown_activated', 'lockdown_lifted',
             'server_started', 'baseline_established'
           )
           AND entry_type = 'event'
         ORDER BY created_at ASC LIMIT 50`,
        [since],
        (err, rows) => err ? reject(err) : resolve(rows || [])
      );
    });
  } catch (e) { /* skip */ }

  // 5. Operating instructions
  const today = new Date().toISOString().substring(0, 10);
  const instructions = _buildOperatingInstructions(leadConfig, folioPath, transcriptDir, today);

  if (format === 'json') {
    return res.json({
      config: {
        sessionCycleMessages: leadConfig.sessionCycleMessages || 50,
        channelContextMessages: leadConfig.channelContextMessages || 100,
        transcriptReadDays: leadConfig.transcriptReadDays || 2,
        stateMaintenance: leadConfig.stateMaintenance !== false,
        stateFile: leadConfig.stateFile || null,
        startupProtocol: leadConfig.startupProtocol !== false,
        executionTierDefault: leadConfig.executionTierDefault || 'supervised',
      },
      state: stateContent,
      transcripts,
      channelMessages: channelMessages.map(m => ({
        from: m.from_user,
        body: m.body?.substring(0, 2000),
        time: m.created_at,
        channel: m.channel_id,
      })),
      coordinationMessages: coordinationMessages.map(m => ({
        from: m.from_user,
        body: m.body?.substring(0, 2000),
        time: m.created_at,
      })),
      handoffNotes: handoffNotes.map(m => ({
        from: m.from_user,
        body: m.body?.substring(0, 2000),
        time: m.created_at,
        channel: m.channel_id,
      })),
      onlineAgents: onlineAgents.map(a => ({
        agent: a.from_user,
        lastSeen: a.last_seen,
      })),
      rateLimitState: rateLimitEvents.map(e => ({
        actor: e.actor,
        action: e.action,
        details: e.details,
        time: e.created_at,
      })),
      systemEvents,
      instructions,
    });
  }

  // Text format — suitable for injecting into any LLM system prompt
  const textParts = [
    `=== DARKHAN SESSION CONTEXT — ${today} ===`,
    '',
    instructions,
    '',
  ];

  if (stateContent) {
    textParts.push('=== CURRENT STATE ===');
    textParts.push(stateContent.substring(0, 5000));
    textParts.push('=== END STATE ===');
    textParts.push('');
  }

  for (const t of transcripts) {
    if (t.content) {
      textParts.push(`=== TRANSCRIPT ${t.date} ===`);
      textParts.push(t.content);
      textParts.push(`=== END TRANSCRIPT ${t.date} ===`);
      textParts.push('');
    }
  }

  if (channelMessages.length > 0) {
    textParts.push('=== RECENT CHANNEL MESSAGES ===');
    for (const m of channelMessages) {
      const time = (m.created_at || '').substring(11, 19);
      textParts.push(`[${time}] ${m.from_user} (${m.channel_id}): ${(m.body || '').substring(0, 1000)}`);
    }
    textParts.push('=== END CHANNEL MESSAGES ===');
    textParts.push('');
  }

  // Session continuity sections
  if (coordinationMessages.length > 0) {
    textParts.push('=== AGENT COORDINATION (last 20 messages) ===');
    for (const m of coordinationMessages) {
      const time = (m.created_at || '').substring(11, 19);
      textParts.push(`[${time}] ${m.from_user}: ${(m.body || '').substring(0, 1500)}`);
    }
    textParts.push('=== END COORDINATION ===');
    textParts.push('');
  }

  if (handoffNotes.length > 0) {
    textParts.push('=== AGENT HANDOFF NOTES (most recent) ===');
    for (const m of handoffNotes) {
      const time = (m.created_at || '').substring(0, 19);
      textParts.push(`[${time}] ${m.from_user}: ${(m.body || '').substring(0, 2000)}`);
      textParts.push('');
    }
    textParts.push('=== END HANDOFF NOTES ===');
    textParts.push('');
  }

  if (onlineAgents.length > 0) {
    textParts.push('=== ONLINE AGENTS (posted in last 30 min) ===');
    for (const a of onlineAgents) {
      const time = (a.last_seen || '').substring(11, 19);
      textParts.push(`  ${a.from_user} — last seen ${time}`);
    }
    textParts.push('=== END ONLINE AGENTS ===');
    textParts.push('');
  }

  if (rateLimitEvents.length > 0) {
    textParts.push('=== RATE LIMIT STATE (last 2 hours) ===');
    for (const e of rateLimitEvents) {
      const time = (e.created_at || '').substring(11, 19);
      textParts.push(`[${time}] ${e.actor}: ${e.action} — ${e.details || ''}`);
    }
    textParts.push('=== END RATE LIMIT STATE ===');
    textParts.push('');
  }

  res.type('text/plain').send(textParts.join('\n'));
});

/**
 * GET /api/context/state — Current state file contents.
 */
router.get('/state', requireAuth, (req, res) => {
  const config = req.app.locals.config;
  const leadConfig = config.leadAgent || {};
  const HOME = process.env.HOME || '';
  const folioPath = (config.folio?.path || '~/darkhan-folio').replace(/^~/, HOME);

  if (!leadConfig.stateFile) {
    return res.status(404).json({ error: 'No state file configured' });
  }

  const stateFilePath = path.join(folioPath, leadConfig.stateFile);
  try {
    const content = fs.readFileSync(stateFilePath, 'utf8');
    res.type('text/markdown').send(content);
  } catch (e) {
    res.status(404).json({ error: `State file not found: ${stateFilePath}` });
  }
});

/**
 * GET /api/context/transcript — Today's transcript (optionally with previous days).
 * Query: ?days=2
 */
router.get('/transcript', requireAuth, (req, res) => {
  const config = req.app.locals.config;
  const days = parseInt(req.query.days) || config.leadAgent?.transcriptReadDays || 1;
  const transcriptDir = path.resolve(__dirname, '..', '..', 'docs', 'transcripts');

  const transcripts = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.now() - i * 86400000).toISOString().substring(0, 10);
    const filePath = path.join(transcriptDir, `Transcript_${date}.md`);
    try {
      transcripts.push({ date, content: fs.readFileSync(filePath, 'utf8') });
    } catch (e) {
      transcripts.push({ date, content: null });
    }
  }

  if (req.query.format === 'json') {
    return res.json({ transcripts });
  }

  const text = transcripts
    .filter(t => t.content)
    .map(t => t.content)
    .join('\n\n---\n\n');

  res.type('text/markdown').send(text || '(No transcripts found)');
});

/**
 * GET /api/context/settings — Lead agent configuration.
 */
router.get('/settings', requireAuth, (req, res) => {
  const config = req.app.locals.config;
  const leadConfig = config.leadAgent || {};
  res.json({
    sessionCycleMessages: leadConfig.sessionCycleMessages || 50,
    channelContextMessages: leadConfig.channelContextMessages || 100,
    transcriptReadDays: leadConfig.transcriptReadDays || 2,
    stateMaintenance: leadConfig.stateMaintenance !== false,
    stateFile: leadConfig.stateFile || null,
    startupProtocol: leadConfig.startupProtocol !== false,
    executionTierDefault: leadConfig.executionTierDefault || 'supervised',
  });
});

/**
 * POST /api/context/settings — Update lead agent settings (admin only).
 * Writes to darkhan.config.json and reloads in memory.
 */
router.post('/settings', requireAuth, async (req, res) => {
  if (!req.session?.userId || req.session.userType !== 'human' || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Only human admins can change lead agent settings' });
  }

  const config = req.app.locals.config;
  const activityLog = req.app.locals.activityLog;
  const updates = req.body;

  // Validate
  const VALID_KEYS = [
    'sessionCycleMessages', 'channelContextMessages', 'transcriptReadDays',
    'stateMaintenance', 'stateFile', 'startupProtocol', 'executionTierDefault',
  ];
  const VALID_TIERS = ['supervised', 'operational', 'autonomous'];

  if (!config.leadAgent) config.leadAgent = {};

  for (const [key, value] of Object.entries(updates)) {
    if (!VALID_KEYS.includes(key)) continue;

    // Type validation
    if (key === 'sessionCycleMessages' || key === 'channelContextMessages' || key === 'transcriptReadDays') {
      const num = parseInt(value);
      if (isNaN(num) || num < 1) continue;
      config.leadAgent[key] = num;
    } else if (key === 'stateMaintenance' || key === 'startupProtocol') {
      config.leadAgent[key] = !!value;
    } else if (key === 'executionTierDefault') {
      if (VALID_TIERS.includes(value)) config.leadAgent[key] = value;
    } else if (key === 'stateFile') {
      // Path validation — must be relative, no ..
      if (typeof value === 'string' && !value.includes('..') && value.length < 200) {
        config.leadAgent[key] = value;
      }
    }
  }

  // Write back to config file
  try {
    const configPath = path.join(__dirname, '..', 'darkhan.config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    if (activityLog) {
      activityLog.append({
        actor: req.session.userId,
        action: 'lead_agent_settings_changed',
        target: 'config',
        details: JSON.stringify(updates),
      });
    }

    console.log(`[Context] Lead agent settings updated by ${req.session.userId}`);
    res.json({ ok: true, settings: config.leadAgent });
  } catch (e) {
    res.status(500).json({ error: `Failed to save config: ${e.message}` });
  }
});

/**
 * Build operating instructions for any lead agent.
 * These are agent-agnostic — they describe what the platform expects,
 * not how a specific LLM should behave.
 */
function _buildOperatingInstructions(leadConfig, folioPath, transcriptDir, today) {
  const lines = [
    'OPERATING INSTRUCTIONS (from Darkhan platform):',
    '',
  ];

  if (leadConfig.startupProtocol !== false) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10);
    lines.push(
      'MANDATORY STARTUP PROTOCOL:',
      'On your first turn, you MUST read the following files before responding to the user:',
      `1. Today's transcript: ${path.join(transcriptDir, 'Transcript_' + today + '.md')}`,
      `2. Yesterday's transcript: ${path.join(transcriptDir, 'Transcript_' + yesterday + '.md')}`,
      `3. Operating instructions: ${folioPath}/CLAUDE.md (or equivalent agent instructions)`,
      `4. Current state: ${folioPath}/${leadConfig.stateFile || 'State.md'}`,
      '',
      'After reading, briefly tell the user what you understand the current work to be.',
      'If you skip these reads, you will give the user stale or wrong context.',
      '',
    );
  }

  if (leadConfig.stateMaintenance !== false && leadConfig.stateFile) {
    lines.push(
      'STATE MAINTENANCE:',
      `You are responsible for maintaining ${leadConfig.stateFile}.`,
      'After completing any significant task, update the state file to reflect:',
      '- Sprint progress and completed milestones',
      '- Changed priorities or new decisions',
      '- Infrastructure or deployment state changes',
      'The next agent session depends on this file being current.',
      '',
    );
  }

  lines.push(
    'SESSION PARAMETERS:',
    `- Session cycle threshold: ${leadConfig.sessionCycleMessages || 50} messages`,
    `- Context window: ${leadConfig.channelContextMessages || 100} recent channel messages`,
    `- Transcript depth: ${leadConfig.transcriptReadDays || 2} day(s)`,
    `- Folio path: ${folioPath}`,
    `- Use absolute paths for all file operations.`,
  );

  return lines.join('\n');
}

module.exports = router;
