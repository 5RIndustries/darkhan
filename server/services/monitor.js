/**
 * Darkhan — Health Monitor Service
 *
 * Tracks agent health status (green/amber/red), updates dashboard status lights,
 * and cleans up stale trigger files. Runs every 30 seconds.
 *
 * The auto-responder handles all real-time communication.
 */

const fs = require('fs');
const path = require('path');

const POLL_INTERVAL = 30000;       // 30 seconds (reduced from 15s — less work to do now)
const HEALTH_GREEN = 5 * 60000;    // 5 min
const HEALTH_AMBER = 30 * 60000;   // 30 min

// Load trigger directory from config folio path
let monitorFolioPath;
try {
  const config = require('../darkhan.config.json');
  monitorFolioPath = config.folio?.path;
} catch (e) { /* Config not yet loaded */ }

const resolvedFolio = monitorFolioPath
  ? monitorFolioPath.replace(/^~/, process.env.HOME || '')
  : path.join(process.env.HOME || '', 'darkhan-folio');
const TRIGGER_DIR = path.join(resolvedFolio, 'Triggers');

function startMonitor(db, io) {
  console.log('[Monitor] Health monitor starting — polling every 30s');

  setInterval(() => {
    updateAgentStatus(db, io);
    cleanupTriggerFiles();
  }, POLL_INTERVAL);
}

/**
 * Update agent status based on last message and health pings
 */
function updateAgentStatus(db, io) {
  let agents;
  try {
    const cfg = require('../darkhan.config.json');
    agents = cfg.team?.members?.filter(m => m.type === 'agent').map(m => m.id) || [];
  } catch (e) { /* fallback */ }
  if (!agents?.length) agents = ['agent_darkhan'];
  const now = Date.now();

  agents.forEach(agent => {
    db.get(
      'SELECT created_at FROM messages WHERE from_user = ? ORDER BY created_at DESC LIMIT 1',
      [agent],
      (err, row) => {
        if (err) return;

        let status = 'down';
        let lastActivity = null;

        if (row) {
          lastActivity = row.created_at;
          // Handle both ISO (with Z) and SQLite (without Z) timestamp formats
          const ts = row.created_at.endsWith('Z') ? row.created_at : row.created_at.replace(' ', 'T') + 'Z';
          const age = now - new Date(ts).getTime();
          if (isNaN(age)) {
            status = 'unknown';
          } else if (age < HEALTH_GREEN) {
            status = 'healthy';
          } else if (age < HEALTH_AMBER) {
            status = 'idle';
          } else {
            status = 'down';
          }
        }

        // Also check heartbeat pings
        db.get(
          'SELECT last_ping_at FROM agent_heartbeats WHERE agent = ?',
          [agent],
          (err, ping) => {
            if (!err && ping && ping.last_ping_at) {
              const pts = ping.last_ping_at.endsWith('Z') ? ping.last_ping_at : ping.last_ping_at + 'Z';
              const pingAge = now - new Date(pts).getTime();
              if (!isNaN(pingAge) && pingAge < HEALTH_GREEN && status !== 'healthy') {
                status = 'idle';
              }
            }

            // Upsert into agent_heartbeats
            db.run(
              `INSERT INTO agent_heartbeats (agent, status, last_message_at)
               VALUES (?, ?, ?)
               ON CONFLICT(agent) DO UPDATE SET status = ?, last_message_at = ?`,
              [agent, status, lastActivity, status, lastActivity],
              (err) => { if (err) console.error('[Monitor] Status update failed:', err.message); }
            );
          }
        );
      }
    );
  });
}

/**
 * Clean up trigger files older than 10 minutes
 */
function cleanupTriggerFiles() {
  try {
    if (!fs.existsSync(TRIGGER_DIR)) return;
    const files = fs.readdirSync(TRIGGER_DIR);
    const tenMinAgo = Date.now() - 10 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(TRIGGER_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < tenMinAgo) {
          fs.unlinkSync(filePath);
        }
      } catch (e) { /* ignore individual file errors */ }
    }
  } catch (e) { /* ignore if directory doesn't exist */ }
}

module.exports = { startMonitor };
