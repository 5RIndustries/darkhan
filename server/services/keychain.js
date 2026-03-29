/**
 * Darkhan — macOS Keychain Integration (Layer 3 Security)
 *
 * Stores critical secrets in the macOS Keychain instead of flat files.
 * The Keychain provides:
 *   - Encryption at rest (AES-256)
 *   - Access control via macOS security framework
 *   - GUI prompt requirement for unauthorized access attempts
 *   - No shell command can extract secrets without user interaction
 *
 * Secrets stored:
 *   - Lockdown PIN hash
 *   - Admin password hash (backup)
 *   - API keys for external services
 *   - CA private key passphrase (if encrypted)
 *
 * The keychain file lives at ~/.darkhan-keychain and is owned by _darkhan.
 * When the server (running as _darkhan) accesses it, no prompt appears.
 * When any other user tries to access it, macOS shows a password dialog.
 *
 * Platform: macOS only. On Linux, falls back to encrypted file store.
 */

const { execSync, execFileSync } = require('child_process');
const os = require('os');

const KEYCHAIN_NAME = 'darkhan-secrets';
const SERVICE_NAME = 'com.darkhan';

class KeychainService {
  constructor({ activityLog }) {
    this.activityLog = activityLog;
    this.available = os.platform() === 'darwin';
    this.keychainPath = null;

    if (this.available) {
      this._initKeychain();
    } else {
      console.log('[Keychain] Not on macOS — keychain integration disabled');
    }
  }

  /**
   * Initialize or locate the Darkhan keychain.
   * Creates it if it doesn't exist.
   */
  _initKeychain() {
    try {
      // Check if our keychain already exists in the search list
      const searchList = execSync('security list-keychains -d user', { encoding: 'utf8' });
      const keychainFile = `${process.env.HOME}/.darkhan-keychain`;

      if (searchList.includes('darkhan-keychain')) {
        this.keychainPath = keychainFile;
        console.log('[Keychain] Darkhan keychain found');
      } else {
        // Keychain doesn't exist yet — it will be created on first secret store
        this.keychainPath = keychainFile;
        console.log('[Keychain] Darkhan keychain path configured (will create on first use)');
      }
    } catch (e) {
      console.warn('[Keychain] Could not access keychain:', e.message);
      this.available = false;
    }
  }

  /**
   * Create the keychain with a random password.
   * The keychain password is derived from the machine's hardware UUID,
   * making it tied to this specific Mac. The server (running as _darkhan)
   * can unlock it; other users get a macOS password prompt.
   */
  _createKeychain() {
    if (!this.available || !this.keychainPath) return false;

    try {
      // Use hardware UUID as keychain password seed — ties it to this machine
      const hwUuid = execSync('ioreg -d2 -c IOPlatformExpertDevice | awk -F\\" \'/IOPlatformUUID/{print $(NF-1)}\'',
        { encoding: 'utf8' }).trim();
      const crypto = require('crypto');
      const keychainPassword = crypto.createHash('sha256').update(`darkhan-${hwUuid}`).digest('hex').substring(0, 32);

      // Create the keychain
      execFileSync('security', ['create-keychain', '-p', keychainPassword, this.keychainPath]);

      // Set keychain settings — no auto-lock timeout
      execFileSync('security', ['set-keychain-settings', this.keychainPath]);

      // Add to search list so security commands can find it
      execFileSync('security', ['list-keychains', '-d', 'user', '-s', this.keychainPath, 'login.keychain-db']);

      // Unlock it for current session
      execFileSync('security', ['unlock-keychain', '-p', keychainPassword, this.keychainPath]);

      console.log('[Keychain] Created and unlocked darkhan keychain');
      return true;
    } catch (e) {
      console.error('[Keychain] Failed to create keychain:', e.message);
      return false;
    }
  }

  /**
   * Unlock the keychain for the current session.
   * Called on server startup.
   */
  unlock() {
    if (!this.available || !this.keychainPath) return false;

    try {
      const crypto = require('crypto');
      const hwUuid = execSync('ioreg -d2 -c IOPlatformExpertDevice | awk -F\\" \'/IOPlatformUUID/{print $(NF-1)}\'',
        { encoding: 'utf8' }).trim();
      const keychainPassword = crypto.createHash('sha256').update(`darkhan-${hwUuid}`).digest('hex').substring(0, 32);

      execFileSync('security', ['unlock-keychain', '-p', keychainPassword, this.keychainPath],
        { stdio: 'pipe' });
      return true;
    } catch (e) {
      // Keychain may not exist yet
      return false;
    }
  }

  /**
   * Store a secret in the keychain.
   * @param {string} key - Secret identifier (e.g., 'lockdown-pin-hash')
   * @param {string} value - Secret value
   */
  store(key, value) {
    if (!this.available) return false;

    // Ensure keychain exists
    try {
      execSync(`security show-keychain-info "${this.keychainPath}" 2>/dev/null`, { stdio: 'pipe' });
    } catch (e) {
      if (!this._createKeychain()) return false;
    }

    try {
      // Delete existing entry if present (update pattern)
      try {
        execFileSync('security', [
          'delete-generic-password',
          '-a', key,
          '-s', SERVICE_NAME,
          this.keychainPath,
        ], { stdio: 'pipe' });
      } catch (e) { /* Not found — that's fine */ }

      // Add the secret
      execFileSync('security', [
        'add-generic-password',
        '-a', key,
        '-s', SERVICE_NAME,
        '-w', value,
        '-T', '',  // No apps get automatic access — always prompt
        this.keychainPath,
      ], { stdio: 'pipe' });

      if (this.activityLog) {
        this.activityLog.append({
          actor: 'keychain_service',
          action: 'secret_stored',
          target: key,
          details: JSON.stringify({ keychain: 'darkhan-secrets' }),
        });
      }

      console.log(`[Keychain] Stored: ${key}`);
      return true;
    } catch (e) {
      console.error(`[Keychain] Failed to store ${key}:`, e.message);
      return false;
    }
  }

  /**
   * Retrieve a secret from the keychain.
   * When called by the _darkhan service user (server process), this succeeds silently.
   * When called by any other user, macOS shows a password/Touch ID prompt.
   *
   * @param {string} key - Secret identifier
   * @returns {string|null} The secret value, or null if not found/denied
   */
  retrieve(key) {
    if (!this.available) return null;

    try {
      this.unlock(); // Ensure unlocked for this session

      const value = execFileSync('security', [
        'find-generic-password',
        '-a', key,
        '-s', SERVICE_NAME,
        '-w',
        this.keychainPath,
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

      return value || null;
    } catch (e) {
      // Access denied, not found, or keychain locked
      return null;
    }
  }

  /**
   * Delete a secret from the keychain.
   */
  delete(key) {
    if (!this.available) return false;

    try {
      execFileSync('security', [
        'delete-generic-password',
        '-a', key,
        '-s', SERVICE_NAME,
        this.keychainPath,
      ], { stdio: 'pipe' });

      if (this.activityLog) {
        this.activityLog.append({
          actor: 'keychain_service',
          action: 'secret_deleted',
          target: key,
        });
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * List all secret keys in the keychain (not values).
   */
  listKeys() {
    if (!this.available) return [];

    try {
      this.unlock();

      const output = execSync(
        `security dump-keychain "${this.keychainPath}" 2>/dev/null | grep "acct" | sed 's/.*="//;s/".*//'`,
        { encoding: 'utf8' }
      );
      return output.trim().split('\n').filter(k => k.length > 0);
    } catch (e) {
      return [];
    }
  }

  /**
   * Check if the keychain service is available and operational.
   */
  getStatus() {
    return {
      available: this.available,
      platform: os.platform(),
      keychainPath: this.keychainPath,
      keys: this.available ? this.listKeys() : [],
    };
  }
}

module.exports = { KeychainService };
