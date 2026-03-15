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

IS_CI="${CI:-false}"

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
elif [ "$IS_CI" = "true" ]; then
    warn "claude CLI not found — skipping in CI (install with: npm install -g @anthropic-ai/claude-code)"
else
    fail "claude CLI not found"
    info "Install with: npm install -g @anthropic-ai/claude-code"
    MISSING_CRITICAL=1
fi

# Ollama
if command -v ollama &>/dev/null; then
    ok "ollama $(ollama --version 2>&1 | head -1)"
elif [ "$IS_CI" = "true" ]; then
    warn "ollama not found — skipping in CI (install with: brew install ollama)"
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
mkdir -p ~/.workshop
if [ ! -f ~/.workshop/jobs.json ]; then
    echo '{"tasks":[],"archived":[]}' > ~/.workshop/jobs.json
fi

ok "~/claude-agents/{main,workshop}/"
ok "~/claude-agents/main/{memory,inbox,protocols}/"
ok "~/.workshop/{memory,secrets,logs,state}/"
ok "~/.claude/{state,logs}/"
ok "~/claude-migration/"
ok "~/.workshop/jobs.json"

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

# Protocols
if [ -d "$SCRIPT_DIR/agents/protocols" ]; then
    cp -r "$SCRIPT_DIR/agents/protocols/." ~/claude-agents/main/protocols/
    ok "agents/protocols/ → ~/claude-agents/main/protocols/"
else
    warn "agents/protocols/ not found in package — skipping"
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
    mkdir -p ~/.workshop/launchd
    cp "$SCRIPT_DIR"/launchd/*.plist.template ~/.workshop/launchd/
    ok "launchd/*.plist.template → ~/.workshop/launchd/"
    info "To auto-start on login, manually install plist files from that folder (see Step 10)"
    PYTHON_PATH=$(which python3)
    info "Your Python3 is at: $PYTHON_PATH"
    info "Edit the launchd plist and replace 'REPLACE_WITH_YOUR_PYTHON3_PATH' with '$PYTHON_PATH'"
else
    warn "launchd/ not found in package — skipping"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4: Install Python dependencies
# ─────────────────────────────────────────────────────────────────────────────
section "Step 4: Installing Python dependencies"

pip3 install --quiet -r "$SCRIPT_DIR/bridge/requirements.txt"
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
if [ "$IS_CI" = "true" ]; then
    section "Step 6: Pulling Ollama embedding model"
    warn "CI mode — skipping Ollama model pull (run 'ollama pull nomic-embed-text' after install)"
else
    section "Step 6: Pulling Ollama embedding model"

    section "Starting Ollama daemon"
    if ! ollama list &>/dev/null; then
      info "Starting Ollama in background..."
      ollama serve &>/dev/null &
      sleep 3
      if ! ollama list &>/dev/null; then
        warn "Ollama daemon didn't start. Try running 'ollama serve' in a separate terminal, then re-run this script."
        exit 1
      fi
    fi
    ok "Ollama daemon running"

    info "Downloading nomic-embed-text (~300MB) — this may take a minute..."
    ollama pull nomic-embed-text
    ok "nomic-embed-text ready"
fi

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

# Search common install locations (both Apple Silicon arm64 and Intel x64)
VEC_DYLIB=$(find /opt/homebrew -name "vec0.dylib" 2>/dev/null | head -1)
if [ -z "$VEC_DYLIB" ]; then
    VEC_DYLIB=$(find ~/.npm -path "*/sqlite-vec-darwin-arm64/*" -name "vec0.dylib" 2>/dev/null | head -1)
fi
if [ -z "$VEC_DYLIB" ]; then
    VEC_DYLIB=$(find ~/.npm -path "*/sqlite-vec-darwin-x64/*" -name "vec0.dylib" 2>/dev/null | head -1)
fi
if [ -z "$VEC_DYLIB" ]; then
    VEC_DYLIB=$(find ~/node_modules -path "*/sqlite-vec-darwin-arm64/*" -name "vec0.dylib" 2>/dev/null | head -1)
fi
if [ -z "$VEC_DYLIB" ]; then
    VEC_DYLIB=$(find ~/node_modules -path "*/sqlite-vec-darwin-x64/*" -name "vec0.dylib" 2>/dev/null | head -1)
fi

if [ -n "$VEC_DYLIB" ]; then
    ok "Found sqlite-vec dylib at: $VEC_DYLIB"
    info "Set VEC_DYLIB=\"$VEC_DYLIB\" in your .mcp.json env block"
else
    warn "vec0.dylib not found in common locations"
    info "Apple Silicon: npm install -g sqlite-vec-darwin-arm64"
    info "Intel Mac:     npm install -g sqlite-vec-darwin-x64"
    info "Then re-run this script, or set VEC_DYLIB manually in .mcp.json"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 9: Generate MCP config
# ─────────────────────────────────────────────────────────────────────────────
section "Step 9: Generating MCP config"
MCP_TARGET="$HOME/.claude/.mcp.json"
MCP_SERVER_PATH="$HOME/claude-migration/memory-mcp/server.mjs"

if [ -f "$MCP_TARGET" ]; then
  warn "$MCP_TARGET already exists — skipping. Merge manually with the example at: $SCRIPT_DIR/memory-mcp/.mcp.json.example"
else
  cat > "$MCP_TARGET" << MCPEOF
{
  "mcpServers": {
    "memory-search": {
      "type": "stdio",
      "command": "node",
      "args": ["$MCP_SERVER_PATH"],
      "env": {
        "MEMORY_DIR": "$HOME/.workshop/memory",
        "VEC_DYLIB": "${VEC_DYLIB:-REPLACE_WITH_PATH_TO_vec0.dylib}",
        "OLLAMA_URL": "http://localhost:11434/v1/embeddings",
        "EMBED_MODEL": "nomic-embed-text"
      }
    }
  }
}
MCPEOF
  ok "MCP config written to $MCP_TARGET"
  if [ -z "$VEC_DYLIB" ]; then
    warn "VEC_DYLIB not found — edit $MCP_TARGET and set the correct path."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 10: Print next steps
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
   → MCP config was written to ~/.claude/.mcp.json by setup.sh. If VEC_DYLIB was found, you're done.
   → If not, edit that file and set VEC_DYLIB manually.

6. INDEX YOUR MEMORY FILES
   → After writing memory notes, run: node ~/claude-migration/memory-mcp/indexer.mjs main
   → Re-run whenever you want search to reflect new memory
   → Optional nightly cron: 0 2 * * * node ~/claude-migration/memory-mcp/indexer.mjs main

7. START THE WORKSHOP
   → Terminal 1: python3 ~/claude-migration/telegram-bridge.py
   → Terminal 2: node ~/claude-agents/workshop/workshop-server.js
   → Dashboard: http://localhost:3500

   (Optional: install launchd agents from ~/claude-agents/workshop-starter/launchd/
    to auto-start everything on login — edit the .plist.template files, then:
    cp *.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/<name>.plist)

8. SEND YOUR FIRST MESSAGE
   → Open Telegram, find your bot
   → Send: "Hello! Read your CLAUDE.md and introduce yourself."

SKILLS & COMMANDS
  → View all slash commands across agents at http://localhost:3500 (Skills tab)
  → Full agent command center at http://localhost:3500/command-center.html
  → Optional Pushover notifications: set PUSHOVER_TOKEN and PUSHOVER_USER env vars

NEXTSTEPS
