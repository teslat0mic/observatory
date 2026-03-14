#!/usr/bin/env bash
set -e

# ─────────────────────────────────────────────────────────────────────────────
# Observatory Workshop — Setup Script
# Target: Apple Silicon Mac (M4, macOS), Claude Max $20/month
# Safe to run multiple times (idempotent).
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Color output helpers ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; }
info() { echo -e "  ${CYAN}→${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!${RESET} $1"; }
section() { echo -e "\n${BOLD}$1${RESET}"; echo "────────────────────────────────────────"; }

echo ""
echo "🔭 Observatory Workshop — Setup"
echo "================================"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1: Check dependencies
# ─────────────────────────────────────────────────────────────────────────────
section "Step 1: Checking dependencies"

MISSING_CRITICAL=0

# Node.js v18+
if command -v node &>/dev/null; then
    NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -ge 18 ]; then
        ok "node $(node --version)"
    else
        fail "node found but version is too old (need v18+, got $(node --version))"
        info "Upgrade with: brew install node"
        MISSING_CRITICAL=1
    fi
else
    fail "node not found"
    info "Install with: brew install node"
    MISSING_CRITICAL=1
fi

# Python 3.10+
if command -v python3 &>/dev/null; then
    PY_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)')
    PY_MAJOR=$(python3 -c 'import sys; print(sys.version_info.major)')
    if [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -ge 10 ]; then
        ok "python3 $(python3 --version | cut -d' ' -f2)"
    else
        fail "python3 found but version is too old (need 3.10+, got $(python3 --version))"
        info "Install via: brew install python@3.12"
        MISSING_CRITICAL=1
    fi
else
    fail "python3 not found (should be present on macOS)"
    info "Install via: brew install python@3.12"
    MISSING_CRITICAL=1
fi

# Claude CLI
if command -v claude &>/dev/null; then
    ok "claude $(claude --version 2>&1 | head -1)"
else
    fail "claude CLI not found"
    info "Install with: npm install -g @anthropic-ai/claude-code"
    MISSING_CRITICAL=1
fi

# Ollama
if command -v ollama &>/dev/null; then
    ok "ollama $(ollama --version 2>&1 | head -1)"
else
    fail "ollama not found"
    info "Install with: brew install ollama"
    MISSING_CRITICAL=1
fi

# pip3
if command -v pip3 &>/dev/null; then
    ok "pip3 $(pip3 --version | cut -d' ' -f2)"
else
    fail "pip3 not found"
    info "Usually bundled with python3. Try: python3 -m ensurepip --upgrade"
    MISSING_CRITICAL=1
fi

# Abort if any critical dependency is missing
if [ "$MISSING_CRITICAL" -eq 1 ]; then
    echo ""
    echo -e "${RED}${BOLD}Setup cannot continue — install the missing dependencies above and re-run.${RESET}"
    echo ""
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2: Create directory structure
# ─────────────────────────────────────────────────────────────────────────────
section "Step 2: Creating directory structure"

mkdir -p ~/claude-agents/{main,workshop}/
mkdir -p ~/claude-agents/main/{memory,inbox,protocols}/
mkdir -p ~/.workshop/{memory,secrets,logs,state}/
mkdir -p ~/.claude/{state,logs}/
mkdir -p ~/claude-migration/

ok "~/claude-agents/{main,workshop}/"
ok "~/claude-agents/main/{memory,inbox,protocols}/"
ok "~/.workshop/{memory,secrets,logs,state}/"
ok "~/.claude/{state,logs}/"
ok "~/claude-migration/"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3: Copy files from the starter package
# ─────────────────────────────────────────────────────────────────────────────
section "Step 3: Copying starter files"

# Telegram bridge
if [ -f "$SCRIPT_DIR/bridge/telegram-bridge.py" ]; then
    cp "$SCRIPT_DIR/bridge/telegram-bridge.py" ~/claude-migration/telegram-bridge.py
    ok "bridge/telegram-bridge.py → ~/claude-migration/telegram-bridge.py"
else
    warn "bridge/telegram-bridge.py not found in package — skipping"
fi

if [ -f "$SCRIPT_DIR/bridge/bots.json.example" ]; then
    cp "$SCRIPT_DIR/bridge/bots.json.example" ~/claude-migration/bots.json.example
    ok "bridge/bots.json.example → ~/claude-migration/bots.json.example"
else
    warn "bridge/bots.json.example not found in package — skipping"
fi

# Dashboard
if [ -d "$SCRIPT_DIR/dashboard" ]; then
    cp -r "$SCRIPT_DIR/dashboard/." ~/claude-agents/workshop/
    ok "dashboard/ → ~/claude-agents/workshop/"
else
    warn "dashboard/ not found in package — skipping"
fi

# Memory MCP server
if [ -d "$SCRIPT_DIR/memory-mcp" ]; then
    mkdir -p ~/claude-migration/memory-mcp/
    cp -r "$SCRIPT_DIR/memory-mcp/." ~/claude-migration/memory-mcp/
    ok "memory-mcp/ → ~/claude-migration/memory-mcp/"
else
    warn "memory-mcp/ not found in package — skipping"
fi

# Commandant CLAUDE.md
if [ -f "$SCRIPT_DIR/agents/commandant/CLAUDE.md" ]; then
    # Don't overwrite if user has already customized it
    if [ ! -f ~/claude-agents/main/CLAUDE.md ]; then
        cp "$SCRIPT_DIR/agents/commandant/CLAUDE.md" ~/claude-agents/main/CLAUDE.md
        ok "agents/commandant/CLAUDE.md → ~/claude-agents/main/CLAUDE.md"
    else
        warn "~/claude-agents/main/CLAUDE.md already exists — not overwriting"
        info "See $SCRIPT_DIR/agents/commandant/CLAUDE.md for the template"
    fi
else
    warn "agents/commandant/CLAUDE.md not found in package — skipping"
fi

# Global preferences example
if [ -f "$SCRIPT_DIR/dotclaude/CLAUDE.md.example" ]; then
    cp "$SCRIPT_DIR/dotclaude/CLAUDE.md.example" ~/.claude/CLAUDE.md.example
    ok "dotclaude/CLAUDE.md.example → ~/.claude/CLAUDE.md.example"
else
    warn "dotclaude/CLAUDE.md.example not found in package — skipping"
fi

# launchd plist templates — copy to a known location, manual install required
if [ -d "$SCRIPT_DIR/launchd" ]; then
    mkdir -p ~/claude-agents/workshop-starter/launchd/
    cp -r "$SCRIPT_DIR/launchd/." ~/claude-agents/workshop-starter/launchd/
    ok "launchd/*.plist.template → ~/claude-agents/workshop-starter/launchd/"
    info "To auto-start on login, manually install plist files from that folder (see Step 9)"
else
    warn "launchd/ not found in package — skipping"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4: Install Python dependencies
# ─────────────────────────────────────────────────────────────────────────────
section "Step 4: Installing Python dependencies"

pip3 install --quiet claude-agent-sdk
ok "claude-agent-sdk installed"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5: Install Node.js dependencies
# ─────────────────────────────────────────────────────────────────────────────
section "Step 5: Installing Node.js dependencies"

if [ -f ~/claude-migration/memory-mcp/package.json ]; then
    (cd ~/claude-migration/memory-mcp && npm install --silent)
    ok "memory-mcp npm dependencies installed"
else
    warn "~/claude-migration/memory-mcp/package.json not found — skipping npm install"
fi

if [ -f ~/claude-agents/workshop/package.json ]; then
    (cd ~/claude-agents/workshop && npm install --silent)
    ok "workshop dashboard npm dependencies installed"
else
    warn "~/claude-agents/workshop/package.json not found — skipping npm install"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6: Pull Ollama embedding model
# ─────────────────────────────────────────────────────────────────────────────
section "Step 6: Pulling Ollama embedding model"

info "Downloading embeddinggemma:300m (~300MB) — this may take a minute..."
ollama pull embeddinggemma:300m
ok "embeddinggemma:300m ready"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7: Initialize empty memory databases
# ─────────────────────────────────────────────────────────────────────────────
section "Step 7: Initializing memory databases"

# The memory MCP server initializes schema on first connection.
# We just ensure the file exists so the path resolves cleanly.
touch ~/.workshop/memory/main.sqlite
ok "~/.workshop/memory/main.sqlite created (schema loads on first MCP connect)"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8: Locate sqlite-vec dylib
# ─────────────────────────────────────────────────────────────────────────────
section "Step 8: Locating sqlite-vec dylib"

VEC_DYLIB=""

# Search common install locations
VEC_DYLIB=$(find /opt/homebrew -name "vec0.dylib" 2>/dev/null | head -1)
if [ -z "$VEC_DYLIB" ]; then
    VEC_DYLIB=$(find ~/.npm -name "vec0.dylib" 2>/dev/null | head -1)
fi
if [ -z "$VEC_DYLIB" ]; then
    VEC_DYLIB=$(find ~/node_modules -name "vec0.dylib" 2>/dev/null | head -1)
fi

if [ -n "$VEC_DYLIB" ]; then
    ok "Found sqlite-vec dylib at: $VEC_DYLIB"
    info "Set VEC_DYLIB=\"$VEC_DYLIB\" in your .mcp.json env block"
else
    warn "vec0.dylib not found in common locations"
    info "Install it with: npm install -g sqlite-vec-darwin-arm64"
    info "Then re-run this script, or set VEC_DYLIB manually in .mcp.json"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 9: Print next steps
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✓ Setup complete! Here's what to do next:${RESET}"
echo ""
cat <<'NEXTSTEPS'
1. CREATE YOUR TELEGRAM BOT
   → Go to Telegram, search @BotFather
   → Send /newbot, follow prompts
   → Save your bot token to: ~/.workshop/secrets/telegram-main.token

2. CONFIGURE YOUR BOTS
   → Copy ~/claude-migration/bots.json.example to ~/claude-migration/bots.json
   → Edit it: add your Telegram user ID and bot token path
   → Get your Telegram user ID from @userinfobot on Telegram

3. PERSONALIZE YOUR COMMANDANT
   → Edit ~/claude-agents/main/CLAUDE.md
   → Fill in your name, timezone, North Star, agent roster

4. SET UP GLOBAL PREFERENCES
   → Copy ~/.claude/CLAUDE.md.example to ~/.claude/CLAUDE.md
   → Fill in your personal preferences

5. CONFIGURE MEMORY MCP
   → Copy memory-mcp/.mcp.json.example to ~/.claude/.mcp.json (or merge with existing)
   → Set VEC_DYLIB path (found above in Step 8)

6. START THE WORKSHOP
   → Terminal 1: python3 ~/claude-migration/telegram-bridge.py
   → Terminal 2: node ~/claude-agents/workshop/workshop-server.js
   → Dashboard: http://localhost:3500

   (Optional: install launchd agents from ~/claude-agents/workshop-starter/launchd/
    to auto-start everything on login — edit the .plist.template files, then:
    cp *.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/<name>.plist)

7. SEND YOUR FIRST MESSAGE
   → Open Telegram, find your bot
   → Send: "Hello! Read your CLAUDE.md and introduce yourself."

NEXTSTEPS
