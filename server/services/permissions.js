/**
 * Darkhan — Permission Management
 *
 * Enforces safe paths for file operations via Darkhan API.
 * Define allowlists, blocklists, and escalation to approval queue.
 */

const path = require('path');

// Load vault path from config, fall back to HOME-relative default
let configVaultPath;
try {
  const config = require('../darkhan.config.json');
  configVaultPath = config.vault?.path;
} catch (e) {
  // Config not loaded yet; will use fallback
}

// Resolve vault base directory from config or environment
const VAULT_BASE = path.normalize(
  configVaultPath
    ? configVaultPath.replace(/^~/, process.env.HOME || '')
    : path.join(process.env.HOME || '', 'darkhan-vault')
);

// Paths agents can write to without approval (override in darkhan.config.json)
let configWritePaths;
try {
  const cfg = require('../darkhan.config.json');
  configWritePaths = cfg.vault?.writeAllowlist;
} catch (e) { /* not loaded yet */ }
const ALLOWLIST_WRITE = configWritePaths || [
  'project/output/',      // Default output directory
  'project/intel/',       // Research and analysis
  'project/decisions/',   // Decision logs
];

// Paths that are completely blocked (never allowed, never queued)
const BLOCKLIST = [
  '.env',                 // Hardcoded paths, secrets
  'node_modules',
  '.git',
  '.obsidian',
  'CLAUDE.md',            // System prompt
  'SOUL.md',              // Agent specs
  'AGENTS.md',
  'MEMORY.md',
  'Daily Journal',
];

/**
 * Normalize a vault-relative path
 * Input: "project/intel/some-file.md"
 * Output: "/full/path/to/project/intel/some-file.md"
 */
function normalizePath(relativePath) {
  const full = path.normalize(path.join(VAULT_BASE, relativePath));
  // Security: ensure no path traversal escapes the vault
  if (!full.startsWith(VAULT_BASE)) {
    return null; // Path escaped vault bounds
  }
  return full;
}

/**
 * Check if a path is in the blocklist
 */
function isBlocked(vaultPath) {
  const pathLower = vaultPath.toLowerCase();
  for (const blocked of BLOCKLIST) {
    if (pathLower.includes(blocked.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a path is in the allowlist
 */
function isAllowed(vaultPath) {
  const pathLower = vaultPath.toLowerCase();
  for (const allowed of ALLOWLIST_WRITE) {
    if (pathLower.startsWith(allowed.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Main permission check
 * 
 * action_type: 'file_read' | 'file_write' | 'command' | 'agent_deploy'
 * action_detail: vault path or command string
 * 
 * Returns: { status: 'allowed' | 'queued' | 'denied', reason?: string }
 */
function checkPermission(actionType, actionDetail) {
  // Validate input
  if (!actionType || !actionDetail) {
    return { status: 'denied', reason: 'Invalid action' };
  }

  // File operations
  if (actionType === 'file_read' || actionType === 'file_write') {
    const vaultPath = actionDetail;

    // Check for path traversal (.. in path)
    if (vaultPath.includes('..')) {
      return { status: 'denied', reason: 'Path traversal not allowed' };
    }

    // For reads, allow anything in vault (blocklist only applies to writes)
    if (actionType === 'file_read') {
      return { status: 'allowed' };
    }

    // Check blocklist for writes
    if (isBlocked(vaultPath)) {
      return { status: 'denied', reason: 'This path is blocked' };
    }

    // For writes, check allowlist
    if (actionType === 'file_write') {
      if (isAllowed(vaultPath)) {
        return { status: 'allowed' };
      } else {
        // Outside allowlist — queue for approval
        return { status: 'queued', reason: 'Path requires approval' };
      }
    }
  }

  // Command execution — handled by Claude relay, not direct API
  if (actionType === 'command') {
    return { status: 'denied', reason: 'Command execution is handled by the Claude relay' };
  }

  // Agent deployment — handled by Claude relay
  if (actionType === 'agent_deploy') {
    return { status: 'denied', reason: 'Agent deployment is handled by the Claude relay' };
  }

  return { status: 'denied', reason: 'Unknown action type' };
}

module.exports = {
  checkPermission,
  normalizePath,
  isBlocked,
  isAllowed,
  VAULT_BASE,
  ALLOWLIST_WRITE,
  BLOCKLIST,
};
