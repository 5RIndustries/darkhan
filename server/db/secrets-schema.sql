-- ============================================================
-- Darkhan — Secrets Database Schema
-- Separated from main darkhan.db for credential isolation.
-- This database stores ONLY sensitive authentication data.
-- File permissions: 600 (owner-only read/write).
--
-- Workers receive darkhan.db but NEVER secrets.db.
-- Only the server process and auth middleware access this DB.
-- ============================================================

-- Credentials — one row per user, keyed by user_id
CREATE TABLE IF NOT EXISTS credentials (
  user_id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  api_key TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sensitive settings (lockdown PIN hash, etc.)
-- Moved from darkhan.db settings table for credential isolation.
CREATE TABLE IF NOT EXISTS secret_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
