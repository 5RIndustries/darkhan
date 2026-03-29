#!/bin/bash
#
# Darkhan — Service User Setup (Layer 2 Security)
#
# Creates a '_darkhan' system user on macOS and transfers ownership of
# sensitive files (databases, secrets, .env) to that user. This prevents
# any process running as your developer account (including AI agents with
# shell access) from reading credentials or modifying the database directly.
#
# WHAT THIS DOES:
#   1. Creates _darkhan system user (no login, no home directory)
#   2. Transfers ownership of db/, .env, and integrity baseline to _darkhan
#   3. Sets permissions so only _darkhan can read/write these files
#   4. Creates a launchd plist to run Darkhan as _darkhan
#   5. Adds the owner user to a 'darkhan' group for code file access
#
# WHAT THIS DOES NOT DO:
#   - Does not modify code files (they stay owned by the developer user)
#   - Does not move any files (they stay in the same locations)
#   - Does not delete anything
#
# REVERSIBLE:
#   To undo: sudo chown -R $(whoami):staff ~/darkhan/server/db ~/darkhan/server/.env
#
# REQUIRES: sudo (macOS admin password)
#
# Usage: sudo bash setup-service-user.sh
#

set -euo pipefail

# --- Configuration ---
SERVICE_USER="_darkhan"
SERVICE_GROUP="darkhan"
DARKHAN_DIR="$HOME/darkhan"
SERVER_DIR="$DARKHAN_DIR/server"
DB_DIR="$SERVER_DIR/db"
ENV_FILE="$SERVER_DIR/.env"
BASELINE_FILE="$HOME/.darkhan-integrity-baseline.json"
CERTS_DIR="$HOME/.darkhan-certs"
OWNER_USER="${DARKHAN_OWNER:-$(whoami)}"

echo "=== Darkhan Service User Setup (Layer 2) ==="
echo ""
echo "This script will:"
echo "  1. Create system user: $SERVICE_USER"
echo "  2. Create group: $SERVICE_GROUP"
echo "  3. Transfer sensitive file ownership to $SERVICE_USER"
echo "  4. Generate a launchd plist for running Darkhan as $SERVICE_USER"
echo ""

# Check we're running as root
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run with sudo."
  echo "Usage: sudo bash setup-service-user.sh"
  exit 1
fi

# --- Step 1: Create service group ---
echo "--- Step 1: Creating group '$SERVICE_GROUP' ---"
if dscl . -read /Groups/$SERVICE_GROUP 2>/dev/null; then
  echo "Group '$SERVICE_GROUP' already exists."
else
  # Find an available GID in the system range (400-499)
  GID=450
  while dscl . -read /Groups/gid/$GID 2>/dev/null; do
    GID=$((GID + 1))
  done

  dscl . -create /Groups/$SERVICE_GROUP
  dscl . -create /Groups/$SERVICE_GROUP PrimaryGroupID $GID
  dscl . -create /Groups/$SERVICE_GROUP RealName "Darkhan Service"
  # Add the owner user to the group
  dscl . -append /Groups/$SERVICE_GROUP GroupMembership $OWNER_USER
  echo "Group '$SERVICE_GROUP' created (GID $GID), $OWNER_USER added."
fi

# --- Step 2: Create service user ---
echo ""
echo "--- Step 2: Creating system user '$SERVICE_USER' ---"
if dscl . -read /Users/$SERVICE_USER 2>/dev/null; then
  echo "User '$SERVICE_USER' already exists."
else
  # Find an available UID in the system range (400-499)
  UID_NUM=450
  while dscl . -read /Users/uid/$UID_NUM 2>/dev/null; do
    UID_NUM=$((UID_NUM + 1))
  done

  # Get the GID we just created
  SVC_GID=$(dscl . -read /Groups/$SERVICE_GROUP PrimaryGroupID | awk '{print $2}')

  dscl . -create /Users/$SERVICE_USER
  dscl . -create /Users/$SERVICE_USER UniqueID $UID_NUM
  dscl . -create /Users/$SERVICE_USER PrimaryGroupID $SVC_GID
  dscl . -create /Users/$SERVICE_USER UserShell /usr/bin/false
  dscl . -create /Users/$SERVICE_USER RealName "Darkhan Service Account"
  dscl . -create /Users/$SERVICE_USER NFSHomeDirectory /var/empty
  # Hide from login screen
  dscl . -create /Users/$SERVICE_USER IsHidden 1

  echo "User '$SERVICE_USER' created (UID $UID_NUM, GID $SVC_GID, no login shell)."
fi

# --- Step 3: Transfer ownership of sensitive files ---
echo ""
echo "--- Step 3: Transferring sensitive file ownership ---"

# Database files
if [ -d "$DB_DIR" ]; then
  chown -R $SERVICE_USER:$SERVICE_GROUP "$DB_DIR"
  chmod 700 "$DB_DIR"
  chmod 600 "$DB_DIR"/*.db 2>/dev/null || true
  chmod 600 "$DB_DIR"/*.db-wal 2>/dev/null || true
  chmod 600 "$DB_DIR"/*.db-shm 2>/dev/null || true
  # Schema and seed files need to be readable by owner user for code review
  chmod 644 "$DB_DIR"/*.sql 2>/dev/null || true
  chmod 644 "$DB_DIR"/seed.js 2>/dev/null || true
  echo "  db/ -> $SERVICE_USER (700 dir, 600 db files)"
fi

# .env file
if [ -f "$ENV_FILE" ]; then
  chown $SERVICE_USER:$SERVICE_GROUP "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  .env -> $SERVICE_USER (600)"
fi

# Integrity baseline
if [ -f "$BASELINE_FILE" ]; then
  chown $SERVICE_USER:$SERVICE_GROUP "$BASELINE_FILE"
  chmod 600 "$BASELINE_FILE"
  echo "  .darkhan-integrity-baseline.json -> $SERVICE_USER (600)"
fi

# TLS certificates (CA key is the crown jewel)
if [ -d "$CERTS_DIR" ]; then
  chown -R $SERVICE_USER:$SERVICE_GROUP "$CERTS_DIR"
  chmod 700 "$CERTS_DIR"
  chmod 600 "$CERTS_DIR"/*.key 2>/dev/null || true
  chmod 644 "$CERTS_DIR"/*.crt 2>/dev/null || true
  echo "  .darkhan-certs/ -> $SERVICE_USER (700 dir, 600 keys, 644 certs)"
fi

# --- Step 4: Code files stay with owner ---
echo ""
echo "--- Step 4: Verifying code file ownership ---"
# Ensure code files are owned by the developer (not the service user)
chown -R $OWNER_USER:staff "$SERVER_DIR"/*.js 2>/dev/null || true
chown -R $OWNER_USER:staff "$SERVER_DIR"/services/ 2>/dev/null || true
chown -R $OWNER_USER:staff "$SERVER_DIR"/routes/ 2>/dev/null || true
chown -R $OWNER_USER:staff "$SERVER_DIR"/middleware/ 2>/dev/null || true
chown -R $OWNER_USER:staff "$SERVER_DIR"/workers/ 2>/dev/null || true
chown -R $OWNER_USER:staff "$DARKHAN_DIR"/client/ 2>/dev/null || true
chown $OWNER_USER:staff "$DARKHAN_DIR"/*.md 2>/dev/null || true
echo "  Code files remain owned by $OWNER_USER"

# --- Step 5: Generate launchd plist ---
echo ""
echo "--- Step 5: Generating launchd plist ---"
PLIST_PATH="/Library/LaunchDaemons/com.darkhan.server.plist"

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.darkhan.server</string>
  <key>UserName</key>
  <string>$SERVICE_USER</string>
  <key>GroupName</key>
  <string>$SERVICE_GROUP</string>
  <key>WorkingDirectory</key>
  <string>$DARKHAN_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>$SERVER_DIR/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/$OWNER_USER</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/darkhan/server.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/darkhan/server.error.log</string>
</dict>
</plist>
PLIST

# Create log directory
mkdir -p /var/log/darkhan
chown $SERVICE_USER:$SERVICE_GROUP /var/log/darkhan

echo "  Plist written to $PLIST_PATH"
echo "  Log directory: /var/log/darkhan"

# --- Step 6: Update break-glass ---
echo ""
echo "--- Step 6: Break-glass now requires sudo ---"
echo "  To run break-glass commands, use:"
echo "    sudo -u $SERVICE_USER node server/break-glass.js <command>"
echo "  This requires your macOS admin password."

# --- Summary ---
echo ""
echo "=== Setup Complete ==="
echo ""
echo "File ownership:"
echo "  $SERVICE_USER owns: db/, .env, .darkhan-integrity-baseline.json, .darkhan-certs/"
echo "  $OWNER_USER owns:   *.js, services/, routes/, workers/, client/, *.md"
echo ""
echo "What agents CAN still do:"
echo "  - Edit code files (*.js, *.md)"
echo "  - Read code files"
echo "  - Git operations"
echo ""
echo "What agents can NO LONGER do:"
echo "  - Read database files (darkhan.db, secrets.db, sessions.db)"
echo "  - Read .env (API keys, secrets)"
echo "  - Read/write integrity baseline"
echo "  - Read TLS private keys"
echo "  - Run break-glass without sudo + PIN"
echo ""
echo "Next steps:"
echo "  1. Stop the current Darkhan server: kill \$(pgrep -f 'node server/server.js')"
echo "  2. Load the new launchd service: sudo launchctl load $PLIST_PATH"
echo "  3. Verify: curl http://localhost:3001/"
echo "  4. Test break-glass: sudo -u $SERVICE_USER node server/break-glass.js status"
echo ""
echo "To revert:"
echo "  sudo chown -R $OWNER_USER:staff $DB_DIR $ENV_FILE"
echo "  sudo launchctl unload $PLIST_PATH"
echo "  rm $PLIST_PATH"
