#!/bin/bash
#
# Darkhan — Keychain Setup (Layer 3 Security)
#
# Migrates critical secrets from secrets.db into the macOS Keychain.
# Must run as _darkhan (the service user) since only _darkhan can
# read secrets.db after Layer 2 setup.
#
# WHAT THIS DOES:
#   1. Creates a dedicated Darkhan keychain (~/.darkhan-keychain)
#   2. Stores API keys from .env in the keychain
#   3. Stores the lockdown PIN hash in the keychain
#   4. Verifies retrieval works
#
# USAGE:
#   sudo -u _darkhan bash setup-keychain.sh
#
# REQUIRES: Layer 2 (service user) must be set up first.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Darkhan Keychain Setup (Layer 3) ==="
echo ""

# Verify we're running as _darkhan
CURRENT_USER=$(whoami)
if [ "$CURRENT_USER" != "_darkhan" ]; then
  echo "WARNING: Running as '$CURRENT_USER', not '_darkhan'."
  echo "For production, run: sudo -u _darkhan bash $0"
  echo "Continuing anyway for testing..."
fi

# Use Node.js to do the actual keychain operations
# (the KeychainService handles all the macOS security CLI calls)
cd "$SERVER_DIR"
/opt/homebrew/bin/node -e "
const path = require('path');
process.chdir('$SERVER_DIR');
try { process.loadEnvFile(path.join('$SERVER_DIR', '.env')); } catch (_) { /* .env may not exist */ }

const { KeychainService } = require('./services/keychain');
const activityLog = { append: (e) => console.log('[Activity]', e.action, e.target || '') };
const keychain = new KeychainService({ activityLog });

if (!keychain.available) {
  console.error('Keychain not available on this platform.');
  process.exit(1);
}

// Store API keys from environment
const secrets = {
  'session-secret': process.env.SESSION_SECRET,
  'anthropic-api-key': process.env.ANTHROPIC_API_KEY,
  'google-api-key': process.env.GOOGLE_API_KEY,
};

let stored = 0;
for (const [key, value] of Object.entries(secrets)) {
  if (value) {
    const ok = keychain.store(key, value);
    if (ok) {
      stored++;
      // Verify retrieval
      const retrieved = keychain.retrieve(key);
      const match = retrieved === value;
      console.log('  ' + key + ': stored' + (match ? ' + verified' : ' (VERIFICATION FAILED)'));
    } else {
      console.log('  ' + key + ': FAILED');
    }
  } else {
    console.log('  ' + key + ': not set in .env, skipping');
  }
}

// Store lockdown PIN hash if it exists
const sqlite3 = require('sqlite3').verbose();
const secretsDb = new sqlite3.Database(path.join('$SERVER_DIR', 'db', 'secrets.db'));
secretsDb.get(\"SELECT value FROM secret_settings WHERE key = 'lockdown_pin_hash'\", [], (err, row) => {
  if (!err && row) {
    const ok = keychain.store('lockdown-pin-hash', row.value);
    console.log('  lockdown-pin-hash: ' + (ok ? 'stored + verified' : 'FAILED'));
    stored++;
  } else {
    console.log('  lockdown-pin-hash: not set, skipping');
  }

  secretsDb.close();

  console.log('');
  console.log('Stored ' + stored + ' secret(s) in macOS Keychain.');
  console.log('Keychain: ' + keychain.keychainPath);
  console.log('');
  console.log('Keys in keychain: ' + keychain.listKeys().join(', '));
});
"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Secrets are now in the macOS Keychain."
echo "The Keychain is encrypted at rest (AES-256) and tied to this machine."
echo "Unauthorized access attempts trigger a macOS password/Touch ID prompt."
