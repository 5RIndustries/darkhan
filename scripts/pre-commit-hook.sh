#!/bin/bash
# Darkhan pre-commit hook
# Prevents committing secrets, source maps, database files, and sensitive artifacts.
# Installed after reviewing the Anthropic Claude Code source map leak (2026-03-31).

set -e

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0

# --- 1. Block source map files ---
MAPS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.map$' | grep -v 'node_modules/' || true)
if [ -n "$MAPS" ]; then
    echo -e "${RED}BLOCKED: Source map files staged for commit:${NC}"
    echo "$MAPS"
    echo "Source maps expose original source code. Remove them before committing."
    ERRORS=$((ERRORS + 1))
fi

# --- 2. Block database files ---
DBS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(db|db-wal|db-shm)$' || true)
if [ -n "$DBS" ]; then
    echo -e "${RED}BLOCKED: Database files staged for commit:${NC}"
    echo "$DBS"
    echo "Database files may contain user data or credentials."
    ERRORS=$((ERRORS + 1))
fi

# --- 3. Block .env files (not .env.example) ---
ENVS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.env$|\.env\.' | grep -v '\.example' || true)
if [ -n "$ENVS" ]; then
    echo -e "${RED}BLOCKED: Environment files staged for commit:${NC}"
    echo "$ENVS"
    ERRORS=$((ERRORS + 1))
fi

# --- 4. Block private keys and certificates ---
KEYS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(key|pem|csr|p12|pfx)$' || true)
if [ -n "$KEYS" ]; then
    echo -e "${RED}BLOCKED: Private key/certificate files staged for commit:${NC}"
    echo "$KEYS"
    ERRORS=$((ERRORS + 1))
fi

# --- 5. Scan staged files for hardcoded secrets ---
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(js|ts|json|md|yml|yaml|sh)$' | grep -v 'node_modules/' | grep -v 'package-lock' || true)
if [ -n "$STAGED_FILES" ]; then
    # Check for high-entropy strings that look like API keys/tokens
    SECRETS=$(echo "$STAGED_FILES" | xargs grep -lnE '(sk-ant-|sk-[a-zA-Z0-9]{40,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36}|xoxb-|xoxp-)' 2>/dev/null || true)
    if [ -n "$SECRETS" ]; then
        echo -e "${RED}BLOCKED: Possible API keys/tokens detected in staged files:${NC}"
        echo "$SECRETS"
        ERRORS=$((ERRORS + 1))
    fi
fi

# --- 6. Block large files (>5MB — source maps are typically large) ---
LARGE=$(git diff --cached --name-only --diff-filter=ACM | while read f; do
    if [ -f "$f" ]; then
        SIZE=$(wc -c < "$f" 2>/dev/null || echo 0)
        if [ "$SIZE" -gt 5242880 ]; then
            echo "$f ($(( SIZE / 1048576 ))MB)"
        fi
    fi
done)
if [ -n "$LARGE" ]; then
    echo -e "${YELLOW}WARNING: Large files staged (>5MB):${NC}"
    echo "$LARGE"
    echo "Large files may indicate accidental inclusion of build artifacts."
    ERRORS=$((ERRORS + 1))
fi

# --- 7. Block worker config files (contain API keys in practice) ---
WORKERS=$(git diff --cached --name-only --diff-filter=ACM | grep -E 'workers/.*\.worker\.js$' | grep -v 'examples/' || true)
if [ -n "$WORKERS" ]; then
    echo -e "${RED}BLOCKED: Live worker files staged for commit:${NC}"
    echo "$WORKERS"
    echo "Worker files contain API keys and team-specific config. Use examples/ templates instead."
    ERRORS=$((ERRORS + 1))
fi

# --- Result ---
if [ $ERRORS -gt 0 ]; then
    echo ""
    echo -e "${RED}Pre-commit check failed with $ERRORS issue(s). Commit aborted.${NC}"
    echo "Fix the issues above, or bypass with --no-verify (not recommended)."
    exit 1
fi

echo "Pre-commit checks passed."
exit 0
