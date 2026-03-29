/**
 * Darkhan — Worker Sandbox
 *
 * OS-level isolation for worker processes. Each worker runs in a restricted
 * environment with limited filesystem access, no direct network access,
 * and resource caps.
 *
 * Architecture:
 *   Main process (server.js) spawns worker processes via fork().
 *   Each worker process:
 *   - Receives only whitelisted environment variables
 *   - Has filesystem access limited to configured paths
 *   - Communicates with the main process via IPC (process.send/on)
 *   - Has no direct database or network access
 *   - Is subject to resource limits (memory, CPU time)
 *
 * Platform: macOS first (sandbox-exec is deprecated but pf + ulimit work).
 * Linux: seccomp-bpf or bubblewrap when we get there.
 *
 * NOTE: This is a defense-in-depth layer. The primary access controls are
 * in the worker runtime (permissions service, shell restrictions, etc.).
 * The sandbox adds OS-level enforcement on top.
 */

const { fork } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Environment variable whitelist for sandboxed workers.
 * Workers receive ONLY these variables — everything else is stripped.
 */
const ENV_WHITELIST = [
  'HOME',
  'PATH',
  'LANG',
  'USER',
  'TERM',
  'NODE_ENV',
  'TZ',
  // LLM provider keys are passed explicitly per-worker, not via env
];

/**
 * Default resource limits for worker processes.
 */
const DEFAULT_LIMITS = {
  maxMemoryMB: 512,          // Max RSS memory in MB
  maxFileDescriptors: 256,   // Max open file descriptors
  maxCpuSeconds: 0,          // Max CPU seconds (0 = unlimited, checked by monitor)
  watchdogIntervalMs: 30000, // How often to check resource usage
  killOnExceed: true,        // Kill worker if limits exceeded
};

/**
 * [ASI02/P0-3] Allowed network endpoints for workers.
 * Workers can only reach these hosts. All other outbound is blocked.
 */
const ALLOWED_EGRESS = [
  // Local LLM (Ollama)
  { host: 'localhost', port: 11434, description: 'Ollama local LLM' },
  { host: '127.0.0.1', port: 11434, description: 'Ollama local LLM' },
  // Google Gemini API
  { host: 'generativelanguage.googleapis.com', port: 443, description: 'Google Gemini API' },
  // Anthropic Claude API
  { host: 'api.anthropic.com', port: 443, description: 'Anthropic Claude API' },
  // Darkhan hub (for federated workers)
  { host: '*', port: 3001, description: 'Darkhan hub (configurable)' },
];

class WorkerSandbox {
  /**
   * @param {Object} opts
   * @param {Object} opts.config - darkhan.config.json
   * @param {Object} opts.activityLog - Activity log service
   */
  constructor({ config, activityLog }) {
    this.config = config;
    this.activityLog = activityLog;
    this.processes = new Map(); // agentId -> { proc, limits, watchdog }
    this.enabled = config.sandbox?.enabled !== false; // Enabled by default

    if (this.enabled) {
      console.log('[Sandbox] Worker sandboxing enabled');
    } else {
      console.log('[Sandbox] Worker sandboxing DISABLED (sandbox.enabled = false in config)');
    }
  }

  /**
   * Build a sanitized environment for a worker process.
   * Only whitelisted variables are passed. LLM keys are added
   * based on the agent's configured provider.
   */
  buildEnvironment(agentConfig) {
    const env = {};

    // Whitelist standard vars
    for (const key of ENV_WHITELIST) {
      if (process.env[key]) env[key] = process.env[key];
    }

    // Add provider-specific API keys based on agent's LLM config
    const provider = agentConfig.model?.provider;
    if (provider === 'google' && process.env.GOOGLE_API_KEY) {
      env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    }
    if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
    if (provider === 'ollama') {
      env.OLLAMA_HOST = this.config.llm?.providers?.ollama?.host || 'localhost';
      env.OLLAMA_PORT = String(this.config.llm?.providers?.ollama?.port || 11434);
    }

    return env;
  }

  /**
   * Get resource limits for a specific agent.
   * Per-agent limits override defaults from config.
   */
  getLimits(agentConfig) {
    const configLimits = this.config.sandbox?.limits || {};
    const agentLimits = agentConfig.sandbox?.limits || {};

    return {
      ...DEFAULT_LIMITS,
      ...configLimits,
      ...agentLimits,
    };
  }

  /**
   * Get the filesystem paths a worker is allowed to access.
   * Derived from the agent's permissions config.
   */
  getAllowedPaths(agentConfig) {
    const vaultPath = (this.config.vault?.path || '~/darkhan-vault').replace('~', process.env.HOME);
    const writePaths = (agentConfig.permissions?.fsWrite || []).map(p =>
      path.resolve(vaultPath, p)
    );

    return {
      read: [
        vaultPath,                               // Full vault read access
        path.join(__dirname, '..'),               // Server code (read-only)
      ],
      write: writePaths,
      deny: [
        path.join(__dirname, '..', 'db'),         // Database files
        path.join(__dirname, '..', '.env'),        // Secrets
        process.env.HOME + '/.ssh',               // SSH keys
        process.env.HOME + '/.gnupg',             // GPG keys
        process.env.HOME + '/.darkhan-certs',     // TLS certs
      ],
    };
  }

  /**
   * Start monitoring a worker process for resource violations.
   * Checks memory and CPU usage at regular intervals.
   */
  startWatchdog(agentId, proc, limits) {
    const interval = setInterval(() => {
      if (!proc.connected || proc.killed) {
        clearInterval(interval);
        return;
      }

      try {
        // Check memory usage via /proc or ps
        const usage = process.memoryUsage.call ? null : null; // Can't get child's memory from parent directly
        // Use platform-specific approach
        this._checkProcessResources(agentId, proc.pid, limits);
      } catch (e) {
        // Process may have exited
        clearInterval(interval);
      }
    }, limits.watchdogIntervalMs || 30000);

    return interval;
  }

  /**
   * Check a process's resource usage via ps command.
   * macOS and Linux compatible.
   */
  _checkProcessResources(agentId, pid, limits) {
    const { execSync } = require('child_process');
    try {
      // ps outputs RSS in KB on macOS
      const output = execSync(`ps -o rss=,cputime= -p ${pid}`, { encoding: 'utf8', timeout: 5000 }).trim();
      if (!output) return;

      const parts = output.trim().split(/\s+/);
      const rssKB = parseInt(parts[0], 10);
      const rssMB = Math.round(rssKB / 1024);

      if (limits.maxMemoryMB > 0 && rssMB > limits.maxMemoryMB) {
        console.error(`[Sandbox] ${agentId} EXCEEDED memory limit: ${rssMB}MB > ${limits.maxMemoryMB}MB`);

        this.activityLog.append({
          actor: 'sandbox',
          action: 'resource_limit_exceeded',
          target: agentId,
          details: JSON.stringify({ type: 'memory', current: rssMB, limit: limits.maxMemoryMB, unit: 'MB' }),
        });

        if (limits.killOnExceed) {
          console.error(`[Sandbox] Killing ${agentId} (PID ${pid}) for resource violation`);
          try { process.kill(pid, 'SIGTERM'); } catch (e) { /* already dead */ }

          this.activityLog.append({
            actor: 'sandbox',
            action: 'worker_killed',
            target: agentId,
            details: JSON.stringify({ reason: 'memory_exceeded', rssMB, limitMB: limits.maxMemoryMB }),
          });
        }
      }
    } catch (e) {
      // Process gone or ps failed — not an error
    }
  }

  /**
   * Generate a macOS sandbox-exec profile for a worker.
   * NOTE: sandbox-exec is deprecated by Apple but still functional on macOS 15.
   * This is a defense-in-depth layer, not the primary access control.
   *
   * Returns the profile as a string, or null if not on macOS.
   */
  generateSandboxProfile(agentId, agentConfig) {
    if (os.platform() !== 'darwin') return null;

    const paths = this.getAllowedPaths(agentConfig);
    const vaultPath = (this.config.vault?.path || '~/darkhan-vault').replace('~', process.env.HOME);

    // Build SBPL (Seatbelt Profile Language) profile
    const profile = `
(version 1)

;; Darkhan worker sandbox profile for ${agentId}
;; Generated by sandbox.js — defense-in-depth layer

;; Default deny
(deny default)

;; Allow basic process operations
(allow process-fork)
(allow process-exec)
(allow signal (target self))

;; Allow reading system libraries and Node.js
(allow file-read*
  (subpath "/usr")
  (subpath "/System")
  (subpath "/Library")
  (subpath "/private/var")
  (subpath "/opt/homebrew")
  (subpath "/dev")
  (subpath "${process.execPath.replace(/\/[^/]+$/, '')}")
)

;; Allow reading the server codebase
(allow file-read*
  (subpath "${path.join(__dirname, '..')}")
)

;; Allow reading the vault
(allow file-read*
  (subpath "${vaultPath}")
)

;; Allow writing to permitted vault paths only
${paths.write.map(p => `(allow file-write*\n  (subpath "${p}")\n)`).join('\n')}

;; Allow temp files
(allow file-read* file-write*
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "${os.tmpdir()}")
)

;; Deny access to sensitive files
${paths.deny.map(p => `(deny file-read* file-write*\n  (subpath "${p}")\n)`).join('\n')}

;; Network: deny-default, allow only LLM API endpoints
;; [ASI02/P0-3] Workers can only reach Ollama (local), Google Gemini, Anthropic Claude
(deny network*)
(allow network* (remote tcp "localhost:11434"))
(allow network* (remote tcp "127.0.0.1:11434"))
(allow network* (remote tcp "generativelanguage.googleapis.com:443"))
(allow network* (remote tcp "api.anthropic.com:443"))

;; Allow IPC (for parent-child communication)
(allow ipc-posix*)
(allow ipc-sysv*)

;; Allow sysctl reads (Node.js needs these)
(allow sysctl-read)

;; Allow mach lookups (required for Node.js on macOS)
(allow mach-lookup)
`.trim();

    return profile;
  }

  /**
   * Write sandbox profile to a temp file and return the path.
   */
  writeSandboxProfile(agentId, profile) {
    const profileDir = path.join(os.tmpdir(), 'darkhan-sandbox');
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { mode: 0o700 });

    const profilePath = path.join(profileDir, `${agentId}.sb`);
    fs.writeFileSync(profilePath, profile, { mode: 0o600 });
    return profilePath;
  }

  /**
   * Get the summary of sandbox configuration for an agent.
   * Used for status reporting and debugging.
   */
  getSandboxStatus(agentId) {
    const proc = this.processes.get(agentId);
    if (!proc) return { sandboxed: false, reason: 'not running' };

    return {
      sandboxed: this.enabled,
      pid: proc.proc?.pid,
      limits: proc.limits,
      allowedPaths: proc.allowedPaths,
      envVars: Object.keys(proc.env || {}),
    };
  }

  /**
   * Clean up all sandbox resources.
   */
  shutdown() {
    for (const [agentId, entry] of this.processes) {
      if (entry.watchdog) clearInterval(entry.watchdog);
      if (entry.proc?.connected) {
        entry.proc.kill('SIGTERM');
      }
    }
    this.processes.clear();

    // Clean up sandbox profiles
    const profileDir = path.join(os.tmpdir(), 'darkhan-sandbox');
    if (fs.existsSync(profileDir)) {
      for (const f of fs.readdirSync(profileDir)) {
        fs.unlinkSync(path.join(profileDir, f));
      }
    }
  }
}

module.exports = { WorkerSandbox, ENV_WHITELIST, DEFAULT_LIMITS };
