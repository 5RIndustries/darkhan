#!/bin/bash
# Darkhan — One-Line Install
#
# Usage:
#   curl -fsSL https://darkhan.ai/install.sh | bash
#   or:
#   bash install.sh
#
# This script:
#   1. Checks/installs prerequisites (Homebrew, Node.js, Ollama, Git)
#   2. Clones the Darkhan repo
#   3. Runs the interactive setup wizard
#
# Works on macOS (Apple Silicon + Intel) and Linux.
# Does NOT require sudo for the main install.

set -e

# Colors
ACCENT='\033[38;5;214m'
GREEN='\033[32m'
RED='\033[31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

success() { echo -e "${GREEN}  ✓${RESET} $1"; }
warn() { echo -e "${ACCENT}  ⚠${RESET} $1"; }
fail() { echo -e "${RED}  ✗${RESET} $1"; }
info() { echo -e "${DIM}  $1${RESET}"; }

echo ""
echo -e "${ACCENT}${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${ACCENT}${BOLD}║     Darkhan — The Forge              ║${RESET}"
echo -e "${ACCENT}${BOLD}║     One-Line Installer               ║${RESET}"
echo -e "${ACCENT}${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""

# ── Detect OS ──
OS="$(uname -s)"
ARCH="$(uname -m)"

if [ "$OS" = "Darwin" ]; then
  info "Detected macOS ($ARCH)"
elif [ "$OS" = "Linux" ]; then
  info "Detected Linux ($ARCH)"
else
  fail "Unsupported OS: $OS"
  exit 1
fi

# ── Homebrew (macOS) ──
if [ "$OS" = "Darwin" ]; then
  if ! command -v brew &> /dev/null; then
    echo ""
    echo -n "  Homebrew is required but not installed. Install it? [Y/n]: "
    read -r INSTALL_BREW
    if [ "${INSTALL_BREW,,}" != "n" ]; then
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

      # Add to PATH for this session (the step users always miss)
      if [ -f "/opt/homebrew/bin/brew" ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
        # Also add to .zprofile so it persists
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile 2>/dev/null
      elif [ -f "/usr/local/bin/brew" ]; then
        eval "$(/usr/local/bin/brew shellenv)"
        echo 'eval "$(/usr/local/bin/brew shellenv)"' >> ~/.zprofile 2>/dev/null
      fi
      success "Homebrew installed and added to PATH"
    else
      fail "Homebrew is required on macOS. Install it and re-run this script."
      exit 1
    fi
  else
    success "Homebrew found"
  fi
fi

# ── Node.js ──
if command -v node &> /dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -ge 20 ]; then
    success "Node.js $(node -v)"
  else
    warn "Node.js $(node -v) is too old (need 20+). Upgrading..."
    if [ "$OS" = "Darwin" ]; then
      brew install node
    else
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    fi
    success "Node.js $(node -v)"
  fi
else
  echo -n "  Node.js is required but not installed. Install it? [Y/n]: "
  read -r INSTALL_NODE
  if [ "${INSTALL_NODE,,}" != "n" ]; then
    if [ "$OS" = "Darwin" ]; then
      brew install node
    else
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    fi
    success "Node.js $(node -v) installed"
  else
    fail "Node.js 20+ is required. Install it and re-run this script."
    exit 1
  fi
fi

# ── Ollama ──
if command -v ollama &> /dev/null; then
  success "Ollama found"
else
  echo -n "  Ollama provides the free local LLM. Install it? [Y/n]: "
  read -r INSTALL_OLLAMA
  if [ "${INSTALL_OLLAMA,,}" != "n" ]; then
    if [ "$OS" = "Darwin" ]; then
      brew install ollama
    else
      curl -fsSL https://ollama.com/install.sh | sh
    fi
    success "Ollama installed"
  else
    warn "Skipping Ollama. Local LLM features will not work until you install it."
  fi
fi

# Start Ollama if not running
if ! curl -s http://localhost:11434/api/tags &> /dev/null; then
  info "Starting Ollama..."
  if [ "$OS" = "Darwin" ]; then
    brew services start ollama 2>/dev/null || ollama serve &>/dev/null &
  else
    ollama serve &>/dev/null &
  fi
  sleep 3
fi

# ── Git ──
if ! command -v git &> /dev/null; then
  echo -e "${BOLD}Installing Git...${RESET}"
  if [ "$OS" = "Darwin" ]; then
    xcode-select --install 2>/dev/null || brew install git
  else
    sudo apt-get install -y git
  fi
fi
success "Git $(git --version | cut -d' ' -f3)"

# ── Clone Darkhan ──
echo ""
INSTALL_DIR="${DARKHAN_DIR:-$HOME/darkhan}"

if [ -d "$INSTALL_DIR" ]; then
  warn "Directory $INSTALL_DIR already exists."
  echo -n "  Use existing directory? [Y/n]: "
  read -r USE_EXISTING
  if [ "${USE_EXISTING,,}" = "n" ]; then
    echo -n "  Install location: "
    read -r INSTALL_DIR
  fi
fi

if [ ! -d "$INSTALL_DIR" ]; then
  echo -e "${BOLD}Cloning Darkhan...${RESET}"
  info "If prompted for credentials, use a GitHub Personal Access Token as the password."
  info "Generate one at: https://github.com/settings/tokens (select 'repo' scope)"
  echo ""
  if ! git clone https://github.com/5RIndustries/darkhan.git "$INSTALL_DIR" 2>/dev/null; then
    echo ""
    warn "Clone failed. This is likely an authentication issue."
    info "For private repos, GitHub requires a Personal Access Token (PAT)."
    info "1. Go to https://github.com/settings/tokens"
    info "2. Generate new token (classic) with 'repo' scope"
    info "3. Re-run this installer and use the token as your password"
    exit 1
  fi
  success "Cloned to $INSTALL_DIR"
else
  success "Using existing $INSTALL_DIR"
  info "Pulling latest changes..."
  cd "$INSTALL_DIR" && git pull 2>/dev/null
fi

# ── Run Setup Wizard ──
echo ""
echo -e "${BOLD}Launching setup wizard...${RESET}"
echo ""
cd "$INSTALL_DIR"
node setup.js
