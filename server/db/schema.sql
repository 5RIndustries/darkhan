-- ============================================================
-- Darkhan — Database Schema
-- Evolved from DARYL v5. Additions marked with [DARKHAN].
-- ============================================================

-- Team members (humans + agents)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,                    -- 'admin', 'member', 'agent', 'system'
  type TEXT DEFAULT 'agent',            -- [DARKHAN] 'human' or 'agent'
  display_name TEXT,                    -- [DARKHAN] Friendly name for UI
  api_key TEXT UNIQUE,                  -- For agent/API access (X-API-Key header)
  notification_prefs TEXT,              -- [DARKHAN] JSON: { pushover, email, etc. }
  status TEXT DEFAULT 'offline',        -- [DARKHAN] 'online', 'away', 'dnd', 'offline'
  last_seen_at DATETIME,               -- [DARKHAN] Last activity timestamp
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Channels
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  from_user TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  type TEXT DEFAULT 'message',          -- 'message', 'alert', 'task_update', 'system'
  reply_to TEXT,
  metadata TEXT,                        -- JSON blob for attachments, etc.
  origin TEXT,                          -- [DARKHAN] Federation: source instance ID
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  assignee TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT DEFAULT 'queued',         -- 'queued', 'in_progress', 'complete', 'promoted'
  priority INTEGER DEFAULT 3,           -- 1=critical, 2=high, 3=normal, 4=low
  vault_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Agent health snapshots
CREATE TABLE IF NOT EXISTS agent_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,                 -- 'healthy', 'down', 'restarting'
  details TEXT,
  checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Default channels (read from config in production, these are fallback)
INSERT OR IGNORE INTO channels (id, name, description) VALUES
  ('chan_command', '#command', 'Primary team channel'),
  ('chan_claude', '#claude', 'Direct to Claude'),
  ('chan_lindsey', '#lindsey', 'Direct to Lindsey'),
  ('chan_coordination', '#coordination', 'Agent coordination'),
  ('chan_alerts', '#alerts', 'System alerts');

-- Claude relay conversation history
CREATE TABLE IF NOT EXISTS claude_conversations (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_use TEXT,
  token_count INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Agent heartbeats (status lights)
CREATE TABLE IF NOT EXISTS agent_heartbeats (
  agent TEXT PRIMARY KEY,
  status TEXT DEFAULT 'unknown',
  last_ping_at TEXT,
  last_message_at TEXT
);

-- Approval queue
CREATE TABLE IF NOT EXISTS approval_queue (
  id TEXT PRIMARY KEY,
  requested_by TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_detail TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- [DARKHAN] Cost tracking — per-agent token and cost accounting
CREATE TABLE IF NOT EXISTS cost_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_millicents INTEGER DEFAULT 0,
  request_type TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cost_agent_date ON cost_tracking (agent, created_at);

-- [DARKHAN] Immutable activity log — append only, no DELETE/UPDATE
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  origin TEXT,                          -- [DARKHAN] Federation: source instance ID
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_log (actor, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log (action, created_at);

-- [DARKHAN] Settings table — key/value store for system config (lockdown PIN, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- [DARKHAN SECURITY] Immutability triggers for activity_log
-- An attacker with sqlite3 CLI can drop these, but it raises the bar
CREATE TRIGGER IF NOT EXISTS prevent_activity_delete
  BEFORE DELETE ON activity_log
  BEGIN
    SELECT RAISE(ABORT, 'activity_log is immutable — DELETE not permitted');
  END;

CREATE TRIGGER IF NOT EXISTS prevent_activity_update
  BEFORE UPDATE ON activity_log
  BEGIN
    SELECT RAISE(ABORT, 'activity_log is immutable — UPDATE not permitted');
  END;
