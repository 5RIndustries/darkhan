/**
 * Darkhan — File Integrity & External Threat Defense
 *
 * This service protects Darkhan from EXTERNAL threats — not just prompt injection
 * through messages, but direct filesystem access, code tampering, database
 * manipulation, and unauthorized configuration changes.
 *
 * THREAT MODEL:
 * 1. Another Claude Code session with filesystem access modifies Darkhan code
 * 2. A rogue agent with shell access tampers with config/code/database
 * 3. Direct sqlite3 CLI access adds unauthorized users or modifies data
 * 4. .env file read by another process to steal API keys
 * 5. Worker files replaced with malicious code
 * 6. Config modified to add rogue team members or weaken security
 *
 * DEFENSES:
 * - File integrity hashing (SHA-256) of all critical files
 * - Periodic integrity verification (every 5 minutes)
 * - Database user count monitoring (detect unauthorized user additions)
 * - Config checksum validation (detect tampering)
 * - File permission enforcement (tighten on startup)
 * - Tamper alerts posted to #alerts and triggers lockdown
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class IntegrityService {
  constructor({ db, activityLog, securityService, config, secretsDb }) {
    this.db = db;
    this.secretsDb = secretsDb || null;
    this.activityLog = activityLog;
    this.securityService = securityService;
    this.config = config;

    // Baseline hashes — computed on startup, verified periodically
    this.baselineHashes = {};
    this.baselineUserCount = 0;
    this.baselineConfigHash = null;

    // Critical files to monitor
    this.serverDir = path.join(__dirname, '..');
    this.criticalFiles = [
      'server.js',
      'darkhan.config.json',
      'middleware/auth.js',
      'services/security.js',
      'services/integrity.js',
      'services/auto-responder.js',
      'services/worker-runtime.js',
      'services/llm.js',
      'routes/messages.js',
      'routes/auth.js',
      'routes/vault.js',
      'db/schema.sql',
      'db/secrets-schema.sql',
      'db/seed.js',
    ];

    // Worker files — monitored separately since they can be added
    this.workerDir = path.join(this.serverDir, 'workers');

    // External baseline file — stored OUTSIDE the Darkhan directory
    // so tampering with Darkhan code doesn't affect the baseline reference
    this.externalBaselinePath = path.join(process.env.HOME, '.darkhan-integrity-baseline.json');

    // Development mode: skip integrity baseline checks during active development.
    // All other security remains active (injection detection, identity enforcement, etc).
    // [M-1 FIX] Enabled via explicit DARKHAN_DEV_MODE=true or config — not NODE_ENV.
    this.devMode = process.env.DARKHAN_DEV_MODE === 'true' || config.integrity?.devMode === true;
    if (this.devMode) {
      console.log('[Integrity] *** DEVELOPMENT MODE — integrity baseline checks DISABLED ***');
      console.log('[Integrity] File tampering will not trigger lockdown. All other security is active.');
      console.log('[Integrity] Set NODE_ENV=production for full integrity enforcement.');
    }

    console.log('[Integrity] Service initializing...');
  }

  /**
   * Compute SHA-256 hash of a file.
   */
  _hashFile(filePath) {
    try {
      const content = fs.readFileSync(filePath);
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch (e) {
      return null; // File doesn't exist or can't be read
    }
  }

  /**
   * Establish baseline — call once on clean startup.
   * Records hashes of all critical files and current user count.
   */
  async establishBaseline() {
    console.log('[Integrity] Establishing baseline...');

    // Hash all critical files
    for (const file of this.criticalFiles) {
      const fullPath = path.join(this.serverDir, file);
      const hash = this._hashFile(fullPath);
      if (hash) {
        this.baselineHashes[file] = hash;
      }
    }

    // Hash worker files
    if (fs.existsSync(this.workerDir)) {
      const workers = fs.readdirSync(this.workerDir).filter(f => f.endsWith('.js'));
      for (const w of workers) {
        const fullPath = path.join(this.workerDir, w);
        const hash = this._hashFile(fullPath);
        if (hash) {
          this.baselineHashes[`workers/${w}`] = hash;
        }
      }
    }

    // Record config hash
    this.baselineConfigHash = this._hashFile(path.join(this.serverDir, 'darkhan.config.json'));

    // Record user count from database
    this.baselineUserCount = await this._getUserCount();

    // Record .env hash (detect API key theft via file modification)
    const envHash = this._hashFile(path.join(this.serverDir, '.env'));
    if (envHash) this.baselineHashes['.env'] = envHash;

    this.activityLog.append({
      actor: 'darkhan_integrity',
      action: 'baseline_established',
      details: JSON.stringify({
        files: Object.keys(this.baselineHashes).length,
        users: this.baselineUserCount,
      }),
    });

    // Record user table hash (detect modifications, not just count changes — P1-R4)
    this.baselineUserHash = await this._hashUserTable();

    console.log(`[Integrity] Baseline: ${Object.keys(this.baselineHashes).length} files hashed, ${this.baselineUserCount} users`);

    // SECURITY: Verify against external baseline BEFORE overwriting.
    // If an attacker modifies files and restarts Darkhan, the tampered files
    // must NOT become the new known-good baseline.
    if (fs.existsSync(this.externalBaselinePath)) {
      try {
        const external = JSON.parse(fs.readFileSync(this.externalBaselinePath, 'utf8'));
        const extHashes = external.hashes || {};
        const tampered = [];

        // Compare ALL files against the external baseline
        for (const [file, extHash] of Object.entries(extHashes)) {
          if (this.baselineHashes[file] && this.baselineHashes[file] !== extHash) {
            tampered.push(file);
            console.error(`[Integrity] *** FILE TAMPERED: ${file} ***`);
          }
        }

        if (tampered.length > 0) {
          // [DEV MODE] In development, log the changes but don't lockdown.
          // Auto-update the baseline to the current file state.
          if (this.devMode) {
            console.warn(`[Integrity] DEV MODE: ${tampered.length} file(s) changed: ${tampered.join(', ')}`);
            console.warn(`[Integrity] DEV MODE: Auto-updating baseline (no lockdown)`);
            this.activityLog.append({
              actor: 'darkhan_integrity',
              action: 'dev_mode_baseline_auto_update',
              details: JSON.stringify({ tamperedFiles: tampered, count: tampered.length }),
            });
            // Fall through to save the new baseline below
          } else {
            // PRODUCTION: Files were modified since last known-good state — DO NOT overwrite baseline
            this.activityLog.append({
              actor: 'darkhan_integrity',
              action: 'STARTUP_TAMPER_DETECTED',
              details: JSON.stringify({
                tamperedFiles: tampered,
                count: tampered.length,
                action: 'baseline_preserved_lockdown_triggered',
              }),
            });

            console.error(`[Integrity] *** ${tampered.length} file(s) modified since external baseline — LOCKDOWN ***`);
            console.error(`[Integrity] External baseline NOT overwritten — preserving known-good state`);

            // Restore in-memory baseline from external (the known-good one)
            this.baselineHashes = extHashes;
            this.baselineUserCount = external.userCount || this.baselineUserCount;
            this.baselineUserHash = external.userHash || this.baselineUserHash;

            // Trigger lockdown
            if (this.securityService) {
              this.securityService.triggerLockdown(
                `CRITICAL: ${tampered.length} file(s) modified since last known-good baseline on restart: ${tampered.join(', ')}`,
                'darkhan_integrity'
              );
            }

            // Enforce permissions and return — do NOT save a new baseline
            this._enforcePermissions();
            return {
              files: Object.keys(this.baselineHashes).length,
              users: this.baselineUserCount,
              tampered,
            };
          }
        }

        // All hashes match — safe to proceed and update the baseline
        console.log('[Integrity] External baseline verification passed — all files match');
      } catch (e) {
        console.warn('[Integrity] Could not read external baseline:', e.message);
      }
    } else {
      console.log('[Integrity] No external baseline found — first boot, creating initial baseline');
    }

    // Save/update external baseline (only reached if verification passed or first boot)
    this._saveExternalBaseline();

    // Enforce file permissions
    this._enforcePermissions();

    return {
      files: Object.keys(this.baselineHashes).length,
      users: this.baselineUserCount,
    };
  }

  /**
   * Save external baseline to disk.
   * Only called when: (a) first boot, (b) verification passed, or (c) admin reset.
   */
  _saveExternalBaseline() {
    try {
      const baselineData = {
        hashes: this.baselineHashes,
        userCount: this.baselineUserCount,
        userHash: this.baselineUserHash,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.externalBaselinePath, JSON.stringify(baselineData, null, 2), { mode: 0o600 });
      console.log(`[Integrity] External baseline saved to ${this.externalBaselinePath}`);
    } catch (e) {
      console.warn('[Integrity] Could not save external baseline:', e.message);
    }
  }

  /**
   * Admin-triggered baseline reset.
   * Re-hashes all current files and saves as the new known-good baseline.
   * Use after making legitimate code changes.
   */
  async resetBaseline() {
    console.log('[Integrity] Admin-triggered baseline reset...');

    // Re-hash all critical files from current state
    this.baselineHashes = {};
    for (const file of this.criticalFiles) {
      const fullPath = path.join(this.serverDir, file);
      const hash = this._hashFile(fullPath);
      if (hash) {
        this.baselineHashes[file] = hash;
      }
    }

    // Re-hash worker files
    if (fs.existsSync(this.workerDir)) {
      const workers = fs.readdirSync(this.workerDir).filter(f => f.endsWith('.js'));
      for (const w of workers) {
        const fullPath = path.join(this.workerDir, w);
        const hash = this._hashFile(fullPath);
        if (hash) {
          this.baselineHashes[`workers/${w}`] = hash;
        }
      }
    }

    // Re-hash config and .env
    this.baselineConfigHash = this._hashFile(path.join(this.serverDir, 'darkhan.config.json'));
    const envHash = this._hashFile(path.join(this.serverDir, '.env'));
    if (envHash) this.baselineHashes['.env'] = envHash;

    // Re-record user baseline
    this.baselineUserCount = await this._getUserCount();
    this.baselineUserHash = await this._hashUserTable();

    // Save to external baseline file
    this._saveExternalBaseline();

    this.activityLog.append({
      actor: 'darkhan_integrity',
      action: 'baseline_reset_by_admin',
      details: JSON.stringify({
        files: Object.keys(this.baselineHashes).length,
        users: this.baselineUserCount,
      }),
    });

    console.log(`[Integrity] Baseline reset: ${Object.keys(this.baselineHashes).length} files, ${this.baselineUserCount} users`);

    return {
      files: Object.keys(this.baselineHashes).length,
      users: this.baselineUserCount,
    };
  }

  /**
   * Verify integrity — compare current state against baseline.
   * Returns { clean: boolean, violations: [] }
   * In dev mode, logs changes but does not trigger lockdown.
   */
  async verify() {
    if (this.devMode) {
      return { clean: true, violations: [], devMode: true };
    }

    const violations = [];

    // Check critical file hashes
    for (const [file, expectedHash] of Object.entries(this.baselineHashes)) {
      const fullPath = file.startsWith('workers/')
        ? path.join(this.workerDir, file.replace('workers/', ''))
        : path.join(this.serverDir, file);

      const currentHash = this._hashFile(fullPath);

      if (!currentHash) {
        violations.push({
          type: 'file_deleted',
          file,
          severity: 'CRITICAL',
          detail: `Critical file ${file} has been deleted`,
        });
      } else if (currentHash !== expectedHash) {
        violations.push({
          type: 'file_modified',
          file,
          severity: 'CRITICAL', // ALL file modifications are critical (P1-R6: .env elevated from HIGH)
          detail: `File ${file} has been modified since startup`,
          expectedHash: expectedHash.substring(0, 12) + '...',
          currentHash: currentHash.substring(0, 12) + '...',
        });
      }
    }

    // Check for new files in workers/ directory (unauthorized worker addition)
    if (fs.existsSync(this.workerDir)) {
      const currentWorkers = fs.readdirSync(this.workerDir).filter(f => f.endsWith('.js'));
      for (const w of currentWorkers) {
        if (!this.baselineHashes[`workers/${w}`]) {
          violations.push({
            type: 'unauthorized_worker',
            file: `workers/${w}`,
            severity: 'CRITICAL',
            detail: `Unauthorized worker file added: ${w}`,
          });
        }
      }
    }

    // Check user table — both count AND content hash (P1-R4)
    const currentUserCount = await this._getUserCount();
    if (currentUserCount !== this.baselineUserCount) {
      violations.push({
        type: 'unauthorized_user',
        severity: 'CRITICAL',
        detail: `User count changed from ${this.baselineUserCount} to ${currentUserCount}`,
      });
    }

    const currentUserHash = await this._hashUserTable();
    if (currentUserHash !== this.baselineUserHash) {
      violations.push({
        type: 'user_table_modified',
        severity: 'CRITICAL',
        detail: 'User table contents modified — possible role escalation, type change, or password change',
      });
    }

    // Check config hash
    const currentConfigHash = this._hashFile(path.join(this.serverDir, 'darkhan.config.json'));
    if (currentConfigHash !== this.baselineConfigHash) {
      violations.push({
        type: 'config_tampered',
        file: 'darkhan.config.json',
        severity: 'CRITICAL',
        detail: 'Configuration file modified since startup',
      });
    }

    // Check .env permissions
    try {
      const envPath = path.join(this.serverDir, '.env');
      if (fs.existsSync(envPath)) {
        const stats = fs.statSync(envPath);
        const mode = (stats.mode & 0o777).toString(8);
        if (mode !== '600' && mode !== '400') {
          violations.push({
            type: 'permission_violation',
            file: '.env',
            severity: 'HIGH',
            detail: `.env has permissions ${mode} — should be 600 or 400`,
          });
        }
      }
    } catch (e) { /* */ }

    // Check secrets.db permissions (credential-isolated database)
    try {
      const secretsPath = path.join(this.serverDir, 'db', 'secrets.db');
      if (fs.existsSync(secretsPath)) {
        const stats = fs.statSync(secretsPath);
        const mode = (stats.mode & 0o777).toString(8);
        if (mode !== '600' && mode !== '400') {
          violations.push({
            type: 'permission_violation',
            file: 'secrets.db',
            severity: 'CRITICAL',
            detail: `secrets.db has permissions ${mode} — MUST be 600 (contains all credentials)`,
          });
        }
      }
    } catch (e) { /* */ }

    // Log and handle violations
    if (violations.length > 0) {
      this.activityLog.append({
        actor: 'darkhan_integrity',
        action: 'INTEGRITY_VIOLATION',
        details: JSON.stringify({
          violationCount: violations.length,
          critical: violations.filter(v => v.severity === 'CRITICAL').length,
          violations: violations.map(v => ({ type: v.type, file: v.file, severity: v.severity })),
        }),
      });

      console.error(`[Integrity] *** ${violations.length} VIOLATION(S) DETECTED ***`);
      violations.forEach(v => console.error(`  [${v.severity}] ${v.detail}`));

      // Auto-lockdown on any CRITICAL violation
      const hasCritical = violations.some(v => v.severity === 'CRITICAL');
      if (hasCritical && this.securityService) {
        const reasons = violations.filter(v => v.severity === 'CRITICAL').map(v => v.detail).join('; ');
        this.securityService.triggerLockdown(`Integrity violation: ${reasons}`, 'darkhan_integrity');
      }
    }

    return { clean: violations.length === 0, violations };
  }

  /**
   * Enforce file permissions on critical files.
   * Called on startup to tighten permissions.
   */
  _enforcePermissions() {
    const restrictedFiles = [
      { path: path.join(this.serverDir, '.env'), mode: 0o600 },
      { path: path.join(this.serverDir, 'db', 'darkhan.db'), mode: 0o600 },
      { path: path.join(this.serverDir, 'db', 'secrets.db'), mode: 0o600 },
      { path: path.join(this.serverDir, 'db', 'sessions.db'), mode: 0o600 },
    ];

    for (const { path: filePath, mode } of restrictedFiles) {
      try {
        if (fs.existsSync(filePath)) {
          fs.chmodSync(filePath, mode);
          console.log(`[Integrity] Permissions set: ${path.basename(filePath)} → ${mode.toString(8)}`);
        }
      } catch (e) {
        console.warn(`[Integrity] Could not set permissions on ${filePath}: ${e.message}`);
      }
    }
  }

  /**
   * Get current user count from database.
   */
  _getUserCount() {
    return new Promise((resolve) => {
      this.db.get('SELECT COUNT(*) as count FROM users', [], (err, row) => {
        resolve(err ? 0 : row.count);
      });
    });
  }

  /**
   * Hash user table contents — detects modifications, not just additions (P1-R4).
   * Catches: role escalation, type change, password change, new users.
   * Uses secrets.db for password hashes when available (credential isolation).
   */
  _hashUserTable() {
    return new Promise((resolve) => {
      this.db.all(
        'SELECT id, role, type FROM users ORDER BY id',
        [],
        (err, rows) => {
          if (err || !rows) return resolve(null);

          // If secrets.db is available, get password hashes from there
          if (this.secretsDb) {
            this.secretsDb.all(
              'SELECT user_id, password_hash FROM credentials ORDER BY user_id',
              [],
              (err2, credRows) => {
                if (err2 || !credRows) {
                  // Fall back to main DB password_hash
                  this._hashUserTableFallback(rows, resolve);
                  return;
                }
                const credMap = {};
                for (const c of credRows) credMap[c.user_id] = c.password_hash;
                const content = rows.map(r => `${r.id}:${r.role}:${r.type}:${credMap[r.id] || ''}`).join('|');
                resolve(crypto.createHash('sha256').update(content).digest('hex'));
              }
            );
          } else {
            this._hashUserTableFallback(rows, resolve);
          }
        }
      );
    });
  }

  /**
   * Fallback: hash user table using password_hash from main DB (backward compatibility).
   */
  _hashUserTableFallback(userRows, resolve) {
    this.db.all(
      'SELECT id, password_hash FROM users ORDER BY id',
      [],
      (err, pwRows) => {
        if (err || !pwRows) return resolve(null);
        const pwMap = {};
        for (const p of pwRows) pwMap[p.id] = p.password_hash;
        const content = userRows.map(r => `${r.id}:${r.role}:${r.type}:${pwMap[r.id] || ''}`).join('|');
        resolve(crypto.createHash('sha256').update(content).digest('hex'));
      }
    );
  }

  /**
   * Check network binding — verify server is only listening on localhost.
   */
  checkNetworkBinding() {
    const violations = [];
    const configuredBindHost = process.env.BIND_HOST || '127.0.0.1';

    // If BIND_HOST is explicitly set to 0.0.0.0, network binding is intentional
    // (e.g., for federated workers on other nodes via Tailscale)
    if (configuredBindHost === '0.0.0.0') {
      return violations; // No violation — admin explicitly configured network access
    }

    // Otherwise, verify server is bound to localhost only
    try {
      const { execSync } = require('child_process');
      const result = execSync(`lsof -i :${this.config.instance?.port || 3001} -P -n`, { encoding: 'utf8', timeout: 5000 });

      if (result.includes('*:') || result.includes('0.0.0.0:')) {
        violations.push({
          type: 'network_exposure',
          severity: 'HIGH',
          detail: 'Darkhan is listening on all interfaces (0.0.0.0) without BIND_HOST being set — potential unauthorized exposure',
        });
      }
    } catch (e) {
      // lsof might fail — not a violation
    }

    return violations;
  }

  /**
   * Get integrity status for dashboard.
   */
  getStatus() {
    return {
      baselineFiles: Object.keys(this.baselineHashes).length,
      baselineUsers: this.baselineUserCount,
      lastCheck: this._lastCheckResult || null,
    };
  }
}

module.exports = { IntegrityService };
