-- ============================================================
-- Darkhan — Database Schema
-- Core schema with federation, security, and audit chain support.
-- ============================================================

-- Team members (humans + agents)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,                    -- 'admin', 'member', 'agent', 'system'
  type TEXT DEFAULT 'agent',            -- [DARKHAN] 'human' or 'agent'
  display_name TEXT,                    -- [DARKHAN] Friendly name for UI
  notification_prefs TEXT,              -- [DARKHAN] JSON: { pushover, email, etc. }
  status TEXT DEFAULT 'offline',        -- [DARKHAN] 'online', 'away', 'dnd', 'offline'
  last_seen_at DATETIME,               -- [DARKHAN] Last activity timestamp
  timezone TEXT DEFAULT 'America/New_York', -- [DARKHAN] IANA timezone for display
  execution_tier TEXT DEFAULT 'supervised', -- [DARKHAN] 'supervised', 'operational', 'autonomous' — controls agent tool approval
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  -- SECURITY: password_hash and api_key are stored ONLY in secrets.db (credential isolation)
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
  trust_level TEXT DEFAULT 'human_verified', -- [MYTHOS] human_verified | agent_local | agent_federated | external | quarantined
  reply_to TEXT,
  metadata TEXT,                        -- JSON blob for attachments, etc.
  origin TEXT,                          -- [DARKHAN] Federation: source instance ID
  signature TEXT,                       -- [MYTHOS] Ed25519 signature of (id + from_user + body + trust_level)
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
  folio_path TEXT,
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

-- Default channels (setup wizard creates team-specific channels from config)
INSERT OR IGNORE INTO channels (id, name, description) VALUES
  ('chan_coordination', '#coordination', 'Primary team channel'),
  ('chan_darkhan', '#darkhan', 'Darkhan system channel'),
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
-- [DARKHAN SECURITY] chain_hash: SHA-256 hash chain for tamper evidence
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  chain_hash TEXT,                      -- [DARKHAN] SHA-256(prev_hash + entry_data) — tamper-evident chain
  origin TEXT,                          -- [DARKHAN] Federation: source instance ID
  entry_type TEXT DEFAULT 'event',      -- [DARKHAN] 'event', 'spacer', or 'anchor' (CRISPR defense)
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

-- [DARKHAN] Ground Truth Registry — verified facts that agents must not contradict
-- Part of the "never-lie" architecture (Output Verification Gate)
CREATE TABLE IF NOT EXISTS ground_truths (
  key TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('metric', 'state', 'identity', 'spec')),
  value TEXT NOT NULL,
  unit TEXT,
  source TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  aliases TEXT,                          -- JSON array of alternate phrasings for claim matching
  notes TEXT,
  deprecated INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_gt_category ON ground_truths (category, deprecated);

-- [DARKHAN] Classification Decision Log — structured triage data for model training
-- Stores classification decisions WITHOUT raw message content (privacy-preserving).
-- This is the training dataset for fine-tuning the Darkhan triage LLM.
CREATE TABLE IF NOT EXISTS triage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_hash TEXT NOT NULL,             -- SHA-256 of message content (never store raw text)
  message_length INTEGER NOT NULL,
  from_user_type TEXT NOT NULL,           -- 'human' or 'agent'
  channel_id TEXT NOT NULL,
  classification TEXT NOT NULL,           -- 'local_llm', 'claude_relay', 'heartbeat_log'
  was_escalated INTEGER DEFAULT 0,        -- 1 if local LLM escalated to Claude
  response_time_ms INTEGER,
  model_name TEXT,                        -- e.g. 'qwen2.5:14b'
  model_version TEXT,                     -- model hash for version tracking
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_triage_classification ON triage_log (classification, created_at);

-- [MYTHOS] Quarantine Queue — messages flagged by two-LLM consensus disagreement
-- Held for human review. Approve releases to channel, reject discards.
-- Both decisions become training data for the classification model.
CREATE TABLE IF NOT EXISTS quarantine_queue (
  id TEXT PRIMARY KEY,
  original_channel TEXT NOT NULL,
  from_user TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  type TEXT DEFAULT 'message',
  local_verdict TEXT,                     -- local LLM classification
  cloud_verdict TEXT,                     -- cloud LLM classification
  consensus TEXT,                         -- 'disagreement', 'threat_consensus', etc.
  metadata TEXT,                          -- JSON blob with full scan results
  status TEXT DEFAULT 'pending',          -- 'pending', 'approved', 'rejected'
  reviewed_by TEXT,                       -- admin who reviewed
  reviewed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_quarantine_status ON quarantine_queue (status, created_at);

-- [MYTHOS] Agent Behavioral Baseline — tracks normal activity patterns per agent
-- Updated daily from the activity log. Deviations trigger alerts.
CREATE TABLE IF NOT EXISTS agent_baselines (
  agent_id TEXT PRIMARY KEY,
  avg_messages_per_day REAL DEFAULT 0,
  avg_llm_calls_per_day REAL DEFAULT 0,
  avg_shell_execs_per_day REAL DEFAULT 0,
  avg_file_writes_per_day REAL DEFAULT 0,
  typical_channels TEXT,                  -- JSON array of channels the agent normally posts to
  typical_active_hours TEXT,              -- JSON array of hours (0-23) the agent is normally active
  sample_days INTEGER DEFAULT 0,          -- how many days of data in the baseline
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- [MYTHOS] Instance Identity — Ed25519 keypair for message signing and federation trust
-- Generated at first startup. Public key shared with federation peers.
-- Private key never leaves this database.
CREATE TABLE IF NOT EXISTS instance_identity (
  key TEXT PRIMARY KEY,                   -- 'ed25519_public' or 'ed25519_private'
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_triage_model ON triage_log (model_name, created_at);

-- [DARKHAN] Observation-Evidence Protocol (OEP) — structured observation records
-- Agents record observations with confidence levels and alternative interpretations.
-- Human reviewers can verify and select alternatives for training feedback.
CREATE TABLE IF NOT EXISTS observation_records (
  id TEXT PRIMARY KEY,
  trace_id TEXT,
  agent_id TEXT NOT NULL,
  observation_type TEXT NOT NULL,
  category TEXT,
  signals TEXT,
  interpretation TEXT,
  confidence REAL,
  confidence_basis TEXT,
  alternative_interpretation TEXT,
  timestamp TEXT NOT NULL,
  hash TEXT,
  verified_by_human INTEGER DEFAULT 0,
  human_selected_alternative TEXT
);
CREATE INDEX IF NOT EXISTS idx_observations_agent ON observation_records(agent_id);
CREATE INDEX IF NOT EXISTS idx_observations_type ON observation_records(observation_type);
CREATE INDEX IF NOT EXISTS idx_observations_trace ON observation_records(trace_id);

-- [DARKHAN] Action-Evidence Protocol (AEP) — execution trace records
-- Tracks task execution with full evidence trails and evaluations.
CREATE TABLE IF NOT EXISTS evidence_traces (
  trace_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  evidence_trail TEXT NOT NULL DEFAULT '[]',
  evaluation TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_evidence_traces_agent ON evidence_traces(agent_id);
CREATE INDEX IF NOT EXISTS idx_evidence_traces_status ON evidence_traces(status);
