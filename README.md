# Workshop Starter

A personal AI agent system — Telegram bots, web dashboard, and persistent memory — built on Claude Code and Claude Max.

Run a team of AI agents from your phone or browser. Each agent has its own identity, memory, and specialty.

---

## What You Get

- **Telegram bots** — one per agent, chat from your phone
- **Web dashboard** at `localhost:3500` — monitor all agents, chat, browse files
- **Persistent memory** per agent — vector + keyword search via local Ollama (no API calls)
- **Agent templates** — commandant, project PM, specialist, dashboard-only advisor
- **Sequential message queue** — one agent processes one message at a time, no chaos

---

## Prerequisites

- macOS — Both Apple Silicon (M-series) and Intel Macs are supported. The correct sqlite-vec binary is selected automatically via optional dependencies.
- **Claude Max subscription ($20/month)** — API keys will not work. This system uses Claude Code, not the Anthropic API.
- Node.js 18+
- Python 3.10+
- [Ollama](https://ollama.ai) — for local embeddings (`ollama pull nomic-embed-text`)
- Telegram account — optional. The dashboard works without any bots.

---

## Quick Start

```bash
git clone https://github.com/[username]/workshop-starter
cd workshop-starter
chmod +x setup.sh
./setup.sh
```

Follow the printed next steps. The setup script handles dependencies, directory scaffolding, and generates LaunchAgent plist files. Check `setup.sh` for the full details rather than repeating them here.

After `setup.sh` completes, you must manually load the LaunchAgents:

```bash
launchctl load ~/Library/LaunchAgents/com.workshop.bridge.plist
launchctl load ~/Library/LaunchAgents/com.workshop.dashboard.plist
```

---

## Architecture

```
Telegram Bot API (long-poll)
    → telegram-bridge.py       # routes messages to agents, HTTP API on :3460
        → Claude Code (claude CLI subprocess, one per message)
            → agent CLAUDE.md loaded from ~/claude-agents/{name}/
                → response back through the chain

workshop-server.js             # web dashboard on :3500, proxies to bridge
memory-mcp/server.mjs          # MCP server: searchable memory via sqlite-vec + Ollama
```

- **`telegram-bridge.py`** — polls up to N Telegram bots concurrently. Routes each message to the right agent directory. Messages to the same agent queue sequentially. Also serves an HTTP API on `:3460` that the dashboard uses.
- **`workshop-server.js`** — web dashboard on `:3500`. Chat interface, agent status, file browser. Proxies agent calls through the bridge.
- **`memory-mcp/server.mjs`** — MCP server that gives agents two tools: `memory_search` and `memory_agents`. Indexes Markdown notes into SQLite with vector embeddings (Ollama, fully local).
- **Each agent** = a directory under `~/claude-agents/{name}/` containing a `CLAUDE.md` (identity + instructions) and a `memory/` folder (daily notes + long-term memory file).

---

## Agent Types

| Type | Template | Role |
|------|----------|------|
| Commandant | `agents/commandant/` | Orchestrates everything. Delegates, never does agent work. |
| Tracker (PM) | `agents/pm/` | Owns a project. Makes decisions. Deploys. |
| Lens (Specialist) | `agents/specialist/` | Deep skill, narrow scope. Invoked by others. |
| Fixed Star (Advisor) | `agents/advisor/` | Dashboard-only persona. No files, just perspective. |

Copy the relevant template into `~/claude-agents/{yourname}/` and fill in the `CLAUDE.md`.

---

## Configuration

**`bots.json`** — maps Telegram bot tokens to agent directories:
```json
[
  {
    "name": "myagent",
    "tokenFile": "~/.workshop/tokens/myagent.token",
    "agentDir": "~/claude-agents/myagent"
  }
]
```
Agents without a `tokenFile` are dashboard-only (no Telegram polling).

**`WORKSHOP_AGENTS_DIR`** — env var to override the default `~/claude-agents/` root.

**`allowedUsers`** — a global list in `bots.json` that applies to all bots. If you add a user, they can message any bot in your system.

**`.mcp.json`** — MCP server config for memory. Requires `VEC_DYLIB` pointing to your `sqlite-vec` dylib. The setup script finds this automatically on macOS.

**`launchd/`** — LaunchAgent plists for auto-starting the bridge and dashboard on login. The setup script generates LaunchAgent plist files and prints the commands to load them. After running `setup.sh`, load them manually:

```bash
launchctl load ~/Library/LaunchAgents/com.workshop.bridge.plist
launchctl load ~/Library/LaunchAgents/com.workshop.dashboard.plist
```

---

## Finding Logs

- Bridge log: `tail -f ~/.claude/logs/telegram-bridge.log`
- Dashboard log: `tail -f ~/.claude/logs/workshop-server.log`

---

## On the $20/Month Plan

- Start with 2–3 Telegram bots. Each message = one Claude Code session.
- The constraint is requests-per-minute, not cost (flat-rate plan).
- Dashboard-only advisors (no Telegram polling) don't consume rate limits unless you actively chat with them.
- The memory system is entirely local — Ollama handles embeddings, no API calls.
- Sessions are resumed by default (not fresh per message), which preserves context.

Multiple agents can run concurrently. Messages to the *same* agent queue sequentially — the bridge enforces this, so you won't get overlapping responses from one bot.

---

### Security Note

All agents spawned by the bridge run with **full filesystem and shell access** — no approval prompts. This is required for autonomous operation. It means:

- Only add Telegram users you trust to `allowedUsers` in `bots.json`
- The dashboard HTTP API has no authentication — only run it on localhost (never expose port 3500 to the network)
- The bridge API on port 3460 is also localhost-only — do not port-forward it

Your `allowedUsers` list is the only gate for Telegram messages. Treat compromised bot tokens as compromised shell access.

> **Important:** Replace `YOUR_TELEGRAM_USER_ID` in each bot's `allowedUsers` with your real Telegram user ID, or ALL messages will be silently rejected. You can find your user ID by messaging [@userinfobot](https://t.me/userinfobot) on Telegram.

---

## Adding an Agent

1. Create the directory: `mkdir -p ~/claude-agents/myagent/{memory,inbox}`
2. Copy a template: `cp -r agents/pm/CLAUDE.md ~/claude-agents/myagent/CLAUDE.md`
3. Fill in the `CLAUDE.md` (name, role, project context)
4. Add an entry to `bots.json` (omit `tokenFile` for dashboard-only)
5. Create the memory database: `touch ~/.workshop/memory/myagent.sqlite`
6. Restart the bridge: `launchctl kickstart -k gui/$(id -u)/com.workshop.bridge`

---

## Memory System

Agents write memory as Markdown files in `~/claude-agents/{agent}/memory/`. The MCP server indexes them into SQLite with vector embeddings for semantic search.

Two tools available to every agent via MCP:

- **`memory_search(query, agent)`** — hybrid vector + keyword search across past notes
- **`memory_agents()`** — list all agent databases

The memory directory convention: `YYYY-MM-DD.md` for daily notes, `MEMORY.md` for curated long-term memory. Agents read both at session start.

### Indexing Your Memory Files

The memory system indexes your `memory/*.md` files into SQLite for search. After writing memory notes, run:

```bash
node ~/claude-migration/memory-mcp/indexer.mjs <agent-name>
# e.g.:
node ~/claude-migration/memory-mcp/indexer.mjs main
```

This is a manual step — re-run it whenever you want search to reflect new memory. Optionally, set up a nightly cron:

```bash
# runs at 2am every night for the main agent
0 2 * * * node ~/claude-migration/memory-mcp/indexer.mjs main
```

---

### Job Board

Agents post tasks for human review. You approve, respond, and optionally route answers back to agents automatically.

**Task types:**
- `manual` — something only you can do (check a file, make a call)
- `approval` — agent is waiting for your go-ahead, response auto-routes back

**Creating a job from an agent:**
```bash
curl -X POST http://localhost:3500/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"title":"Review this PR","detail":"...","project":"myapp","priority":"medium","type":"approval","createdBy":"pm-agent"}'
```

Jobs can include a `sessionKey` and `resumptionTemplate` to enable agent-to-human-to-agent routing — when you complete an approval job, the dashboard automatically routes your response back to the waiting agent.

> **Note:** For automatic result routing back to the requesting agent, include `sessionKey` and `resumptionTemplate` in the job payload. See `agents/protocols/job-board.md` for the full schema.

**Pushover notifications (optional):** Set `PUSHOVER_TOKEN` and `PUSHOVER_USER` env vars for mobile push on high-priority jobs.

---

## Upgrading

After `git pull`, re-run `setup.sh` to copy updated files to `~/claude-migration/` and `~/claude-agents/workshop/`. The files in this repo are templates — the deployed copies live separately and won't update automatically.

```bash
git pull
./setup.sh
```

---

## License

MIT
