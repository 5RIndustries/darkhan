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
  must_change_password INTEGER DEFAULT 1,  -- [DARKHAN] Force password change on first login
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- [DARKHAN] Migration: add must_change_password column if missing (existing databases)
-- SQLite silently ignores duplicate column errors in ALTER TABLE when handled by the app.
-- The server's applySchema() ignores "already exists" errors, so this is safe to re-run.
ALTER TABLE credentials ADD COLUMN must_change_password INTEGER DEFAULT 1;

-- [DARKHAN] Migration: add api_key_hmac for encrypted-at-rest API key lookup.
-- HMAC is deterministic, used for O(1) lookups without decrypting every row.
-- api_key column holds AES-256-GCM encrypted value. api_key_hmac holds HMAC-SHA256.
ALTER TABLE credentials ADD COLUMN api_key_hmac TEXT;
CREATE INDEX IF NOT EXISTS idx_credentials_api_key_hmac ON credentials(api_key_hmac);

-- Sensitive settings (lockdown PIN hash, etc.)
-- Moved from darkhan.db settings table for credential isolation.
CREATE TABLE IF NOT EXISTS secret_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
