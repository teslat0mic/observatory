#!/usr/bin/env python3
"""Telegram Bridge — polls bots, routes messages to Claude Code agents via Agent SDK.
Uses plan pricing (Claude Max/Pro subscription), not API pricing.
The SDK spawns `claude` CLI as a subprocess — all billing via subscription.
Includes HTTP API on :3460 for dashboard integration.
"""

import asyncio
import atexit
import fcntl
import http.client
import json
import os
import re
import shutil
import signal
import ssl
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

from claude_agent_sdk import query as claude_query, ClaudeAgentOptions, ResultMessage, AssistantMessage, TextBlock
from claude_agent_sdk.types import StreamEvent, ToolUseBlock

# --- Config ---
CONFIG_PATH = Path(__file__).parent / "bots.json"

# Configurable via environment variables
AGENTS_DIR = Path(os.environ.get("WORKSHOP_AGENTS_DIR", Path.home() / "claude-agents"))
STATE_DIR  = Path(os.environ.get("WORKSHOP_STATE_DIR", Path.home() / ".claude" / "state"))
LOG_DIR    = Path(os.environ.get("WORKSHOP_LOG_DIR",   Path.home() / ".claude" / "logs"))

OFFSETS_PATH = STATE_DIR / "telegram-offsets.json"
LOG_PATH     = LOG_DIR / "telegram-bridge.log"
PIDFILE      = STATE_DIR / "telegram-bridge.pid"

POLL_TIMEOUT = 30  # seconds
STAGGER_S = 0.5
ERROR_RETRY_S = 10
MAX_MSG_LEN = 4096  # Telegram limit
HTTP_PORT = int(os.environ.get("BRIDGE_HTTP_PORT", "3460"))
_lock_fd = None  # held open for lifetime of process

# Env vars to strip so child claude processes don't detect nesting
NESTING_ENV_VARS = [
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION",
    "CLAUDE_CODE_CONVERSATION_ID", "CLAUDE_AGENT_SDK_VERSION",
]

# --- State ---
offsets: dict[str, int] = {}
queue: asyncio.Queue = None  # initialized in main
shutdown_event: asyncio.Event = None
config: dict = None  # loaded in main, used by HTTP handlers


# --- Logging ---
def log(msg: str):
    line = f"[{datetime.now().isoformat()}] {msg}"
    print(line, flush=True)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


# --- PID file lock (ensures single instance) ---
def acquire_pidfile():
    """Acquire an exclusive lock on the PID file. Kills any stale holder first."""
    global _lock_fd
    PIDFILE.parent.mkdir(parents=True, exist_ok=True)

    # Check for stale process
    if PIDFILE.exists():
        try:
            old_pid = int(PIDFILE.read_text().strip())
            os.kill(old_pid, 0)  # check if alive
            log(f"Killing stale bridge process {old_pid}")
            os.kill(old_pid, signal.SIGTERM)
            # Wait up to 5s for it to die
            for _ in range(50):
                try:
                    os.kill(old_pid, 0)
                    time.sleep(0.1)
                except OSError:
                    break
            # Force kill if still alive
            try:
                os.kill(old_pid, 0)
                log(f"Force-killing stale bridge process {old_pid}")
                os.kill(old_pid, signal.SIGKILL)
                time.sleep(0.5)
            except OSError:
                pass
        except (OSError, ValueError):
            pass  # process already dead or invalid pid

    # Acquire exclusive lock (open append to avoid truncating before lock is held)
    _lock_fd = open(PIDFILE, "a")
    try:
        fcntl.flock(_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("FATAL: Another bridge instance holds the lock. Exiting.", flush=True)
        sys.exit(1)
    _lock_fd.seek(0)
    _lock_fd.truncate()
    _lock_fd.write(str(os.getpid()))
    _lock_fd.flush()
    log(f"PID file acquired: {PIDFILE} (pid={os.getpid()})")


def release_pidfile():
    """Release PID file lock and remove the file."""
    global _lock_fd
    if _lock_fd:
        try:
            fcntl.flock(_lock_fd, fcntl.LOCK_UN)
            _lock_fd.close()
        except Exception:
            pass
        _lock_fd = None
    try:
        PIDFILE.unlink(missing_ok=True)
    except Exception:
        pass


# Shared SSL context (thread-safe, reusable)
_ssl_ctx = ssl.create_default_context()


# --- Telegram API (sync, run in executor) ---
def telegram_api(token: str, method: str, body: dict | None = None) -> dict:
    """Each call creates its own HTTPS connection — fully isolated, no keep-alive."""
    timeout = POLL_TIMEOUT + 10 if method == "getUpdates" else 30
    conn = http.client.HTTPSConnection("api.telegram.org", timeout=timeout, context=_ssl_ctx)
    try:
        headers = {"Connection": "close"}
        if body:
            data = json.dumps(body)
            headers["Content-Type"] = "application/json"
            conn.request("POST", f"/bot{token}/{method}", body=data, headers=headers)
        else:
            conn.request("GET", f"/bot{token}/{method}", headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status != 200:
            raise Exception(f"HTTP {resp.status}: {raw.decode()[:200]}")
        return json.loads(raw)
    finally:
        conn.close()


async def tg(token: str, method: str, body: dict | None = None) -> dict:
    """Async wrapper around sync telegram_api."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, telegram_api, token, method, body)


# --- Offsets ---
def load_offsets():
    global offsets
    try:
        offsets = json.loads(OFFSETS_PATH.read_text())
    except Exception:
        offsets = {}


def save_offsets():
    try:
        OFFSETS_PATH.parent.mkdir(parents=True, exist_ok=True)
        OFFSETS_PATH.write_text(json.dumps(offsets, indent=2))
    except Exception as e:
        log(f"WARN: Failed to save offsets: {e}")


# --- Message splitting ---
def split_message(text: str) -> list[str]:
    if len(text) <= MAX_MSG_LEN:
        return [text]
    chunks = []
    remaining = text
    while remaining:
        if len(remaining) <= MAX_MSG_LEN:
            chunks.append(remaining)
            break
        split_at = remaining.rfind("\n", 0, MAX_MSG_LEN)
        if split_at < MAX_MSG_LEN // 2:
            split_at = MAX_MSG_LEN
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:].lstrip()
    return chunks


# --- Clean env for child processes ---
def build_clean_env() -> dict[str, str]:
    """Build env dict with nesting-detection vars stripped."""
    clean = {k: v for k, v in os.environ.items() if k not in NESTING_ENV_VARS}
    return clean


# --- Chat History ---
def chat_history_path(agent_name: str) -> Path:
    return AGENTS_DIR / agent_name / "chat-history.json"


def load_chat_history(agent_name: str) -> dict:
    p = chat_history_path(agent_name)
    try:
        return json.loads(p.read_text())
    except Exception:
        return {"agent": agent_name, "messages": []}


def append_chat_message(agent_name: str, role: str, text: str, source: str = "telegram", **extra):
    history = load_chat_history(agent_name)
    msg = {
        "id": f"msg_{uuid.uuid4().hex[:12]}",
        "role": role,
        "text": text,
        "source": source,
        "ts": datetime.now().isoformat(),
    }
    msg.update(extra)
    history["messages"].append(msg)
    p = chat_history_path(agent_name)
    p.parent.mkdir(parents=True, exist_ok=True)
    # Atomic write: write to temp file, then rename (prevents corruption on crash)
    tmp = p.with_suffix('.tmp')
    tmp.write_text(json.dumps(history, indent=2))
    tmp.rename(p)


# --- Claude Agent SDK (one-shot query per request) ---

async def run_claude(bot: dict, message_text: str, cfg: dict, on_token=None, on_event=None) -> tuple[str, dict]:
    """Send a message via one-shot query() — fresh subprocess per request.
    continue_conversation=True resumes the agent's latest session from disk.
    include_partial_messages=True gives token-level StreamEvent deltas.
    on_token(text) called for each text delta if provided.
    on_event(type, data) called for tool use and progress events if provided.
    Returns (result_text, metadata).
    """
    options = ClaudeAgentOptions(
        cwd=bot["agentDir"],
        model=cfg.get("model", "sonnet"),
        permission_mode="bypassPermissions",
        max_budget_usd=999,  # Effectively unlimited — flat-rate plan
        setting_sources=["user", "project"],
        env=build_clean_env(),
        continue_conversation=True,
        include_partial_messages=True,
        mcp_servers=Path(__file__).parent / ".mcp.json",
    )

    result_text = ""
    _block_streamed_len = 0  # bytes streamed for CURRENT content block only
    metadata = {}
    _in_tool_block = False

    try:
        async for message in claude_query(prompt=message_text, options=options):
            if isinstance(message, StreamEvent):
                event = message.event
                evt_type = event.get("type", "")
                if evt_type == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta":
                        text = delta.get("text", "")
                        if text:
                            result_text += text
                            _block_streamed_len += len(text)
                            if on_token:
                                on_token(text)
                elif evt_type == "content_block_start":
                    block = event.get("content_block", {})
                    _block_streamed_len = 0  # reset at start of each block
                    if block.get("type") == "tool_use":
                        _in_tool_block = True
                        if on_event:
                            on_event("tool_start", {"tool": block.get("name", "unknown")})
                    else:
                        _in_tool_block = False
                elif evt_type == "content_block_stop":
                    if _in_tool_block and on_event:
                        on_event("tool_stop", {})
                    _in_tool_block = False
            elif isinstance(message, ResultMessage):
                # Only overwrite if result is at least as long as streamed content
                if message.result and len(message.result) >= len(result_text):
                    result_text = message.result
                metadata = {
                    "num_turns": message.num_turns,
                    "cost_usd": message.total_cost_usd or 0,
                    "duration_ms": message.duration_ms,
                    "is_error": message.is_error,
                    "session_id": message.session_id,
                }
                log(f"[{bot['name']}] Query done: {message.num_turns} turns, "
                    f"${message.total_cost_usd or 0:.4f}, {message.duration_ms}ms, "
                    f"error={message.is_error}")
            elif isinstance(message, AssistantMessage):
                for block in (message.content or []):
                    if isinstance(block, TextBlock):
                        if not on_token:
                            # Non-streaming (Telegram): accumulate text
                            result_text += block.text
                        # When streaming: don't send catch-up here.
                        # StreamEvent deltas already sent tokens to the browser,
                        # and the "result" SSE event guarantees final delivery.
                        _block_streamed_len = 0
                    elif isinstance(block, ToolUseBlock):
                        if on_event:
                            on_event("tool_use", {"tool": block.name})
    except Exception as e:
        log(f"[{bot['name']}] Claude SDK error: {e}")
        raise

    return result_text.strip(), metadata


# --- Message processor (sequential) ---
# Queue items: (bot, chat_id, text, from_user, source, sse_queue)
#   source="telegram": from_user is Telegram user dict, sse_queue=None
#   source="dashboard": from_user={"first_name":"Dashboard"}, sse_queue=asyncio.Queue

async def run_ollama(bot: dict, message_text: str, on_token=None) -> tuple[str, dict]:
    """Send a message to a local Ollama model via OpenAI-compatible streaming API.
    Reads system prompt from agentDir/CLAUDE.md if present.
    Returns (result_text, metadata).
    """
    import urllib.request

    ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434/v1/chat/completions")
    ollama_model = bot["ollamaModel"]
    agent_dir = Path(bot.get("agentDir", ""))
    system_prompt = ""
    claude_md = agent_dir / "CLAUDE.md"
    if claude_md.exists():
        system_prompt = claude_md.read_text(encoding="utf-8")

    # Load chat history for context (last 10 exchanges)
    history_path = STATE_DIR / "chat-history" / f"{bot['name']}.jsonl"
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    if history_path.exists():
        lines = history_path.read_text().strip().splitlines()
        for line in lines[-20:]:  # last 10 exchanges = 20 lines
            try:
                entry = json.loads(line)
                if entry.get("role") in ("user", "assistant"):
                    messages.append({"role": entry["role"], "content": entry["content"]})
            except Exception:
                pass
    messages.append({"role": "user", "content": message_text})

    payload = json.dumps({
        "model": ollama_model,
        "messages": messages,
        "stream": True,
    }).encode()

    result_text = ""
    t0 = time.monotonic()
    loop = asyncio.get_event_loop()

    def _stream_ollama():
        nonlocal result_text
        req = urllib.request.Request(
            ollama_url,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            for raw_line in resp:
                line = raw_line.decode().strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                    token = chunk["choices"][0]["delta"].get("content", "")
                    if token:
                        result_text += token
                        if on_token:
                            # Schedule on event loop thread — asyncio.Queue is not thread-safe
                            loop.call_soon_threadsafe(on_token, token)
                except Exception:
                    pass

    await loop.run_in_executor(None, _stream_ollama)

    duration_ms = int((time.monotonic() - t0) * 1000)
    metadata = {"duration_ms": duration_ms, "model": ollama_model, "cost_usd": 0}
    log(f"[{bot['name']}] Ollama done: {len(result_text)} chars, {duration_ms}ms")
    return result_text.strip(), metadata


# --- Per-agent queues for concurrent processing ---
# Each agent gets its own asyncio.Queue and processing task.
# Messages to the same agent are sequential (conversation order),
# but different agents process in parallel.
_agent_queues: dict[str, asyncio.Queue] = {}
_agent_tasks: dict[str, asyncio.Task] = {}


CLAUDE_TIMEOUT_S = int(os.environ.get("CLAUDE_TIMEOUT_S", "600"))  # 10 min default


async def _process_agent_queue(agent_name: str, agent_q: asyncio.Queue, cfg: dict):
    """Process messages for a single agent sequentially."""
    while not shutdown_event.is_set():
        try:
            bot, chat_id, text, from_user, source, sse_q = await asyncio.wait_for(
                agent_q.get(), timeout=5.0
            )
        except asyncio.TimeoutError:
            continue
        except asyncio.CancelledError:
            raise

        try:
            from_name = from_user.get("first_name", str(from_user.get("id", "?")))
            log(f"[{agent_name}] Processing from {from_name} ({source}): \"{text[:60]}...\"")

            # Write user message to chat history
            append_chat_message(agent_name, "user", text, source=source)

            t0 = time.monotonic()

            try:
                if source == "telegram":
                    await tg(bot["token"], "sendChatAction", {"chat_id": chat_id, "action": "typing"})

                def on_token(token_text):
                    if sse_q:
                        sse_q.put_nowait(("token", token_text))

                def on_event(event_type, data):
                    if sse_q:
                        sse_q.put_nowait(("progress", {"type": event_type, **data}))

                if bot.get("ollamaModel"):
                    response, metadata = await asyncio.wait_for(
                        run_ollama(bot, text, on_token=on_token if sse_q else None),
                        timeout=CLAUDE_TIMEOUT_S,
                    )
                else:
                    response, metadata = await asyncio.wait_for(
                        run_claude(bot, text, cfg,
                                   on_token=on_token if sse_q else None,
                                   on_event=on_event if sse_q else None),
                        timeout=CLAUDE_TIMEOUT_S,
                    )

                duration_ms = int((time.monotonic() - t0) * 1000)

                append_chat_message(agent_name, "assistant", response or "(no response)",
                                    source=source, duration_ms=duration_ms)

                if source == "telegram":
                    chunks = split_message(response or "(no response)")
                    for chunk in chunks:
                        try:
                            await tg(bot["token"], "sendMessage", {
                                "chat_id": chat_id,
                                "text": chunk,
                                "parse_mode": "Markdown",
                            })
                        except Exception:
                            await tg(bot["token"], "sendMessage", {
                                "chat_id": chat_id,
                                "text": chunk,
                            })
                    log(f"[{agent_name}] Replied ({len(response)} chars, {len(chunks)} msg(s))")

                if sse_q:
                    sse_q.put_nowait(("result", response or ""))
                    sse_q.put_nowait(("done", metadata))

            except asyncio.TimeoutError:
                log(f"[{agent_name}] TIMEOUT after {CLAUDE_TIMEOUT_S}s")
                if sse_q:
                    sse_q.put_nowait(("error", f"Agent timed out after {CLAUDE_TIMEOUT_S}s"))
                if source == "telegram":
                    try:
                        await tg(bot["token"], "sendMessage", {
                            "chat_id": chat_id,
                            "text": f"Sorry, I timed out after {CLAUDE_TIMEOUT_S}s.",
                        })
                    except Exception:
                        pass

            except Exception as e:
                log(f"[{agent_name}] ERROR: {e}")
                if source == "telegram":
                    try:
                        await tg(bot["token"], "sendMessage", {
                            "chat_id": chat_id,
                            "text": "Sorry, I hit an error. Try again?",
                        })
                    except Exception:
                        pass
                if sse_q:
                    sse_q.put_nowait(("error", str(e)))

        except asyncio.CancelledError:
            raise
        except Exception as e:
            # Outer guard: never let the worker die from unexpected exceptions
            log(f"[{agent_name}] FATAL unexpected error in worker: {e}")
            if sse_q:
                try:
                    sse_q.put_nowait(("error", f"Internal error: {e}"))
                except Exception:
                    pass
        finally:
            agent_q.task_done()


def _get_agent_queue(agent_name: str, cfg: dict) -> asyncio.Queue:
    """Get or create a per-agent queue and processing task."""
    if agent_name not in _agent_queues:
        q = asyncio.Queue()
        _agent_queues[agent_name] = q
        _agent_tasks[agent_name] = asyncio.create_task(
            _process_agent_queue(agent_name, q, cfg)
        )
        log(f"[{agent_name}] Created per-agent processing queue")
    return _agent_queues[agent_name]


async def process_messages(cfg: dict):
    """Dispatch incoming messages to per-agent queues for concurrent processing."""
    while not shutdown_event.is_set():
        try:
            bot, chat_id, text, from_user, source, sse_q = await asyncio.wait_for(
                queue.get(), timeout=1.0
            )
        except asyncio.TimeoutError:
            continue

        agent_q = _get_agent_queue(bot["name"], cfg)
        agent_q.put_nowait((bot, chat_id, text, from_user, source, sse_q))
        queue.task_done()


# --- Long-polling per bot ---
async def poll_bot(bot: dict, config: dict):
    """Long-poll a single Telegram bot for updates."""
    allowed = config.get("allowedUsers", [])

    while not shutdown_event.is_set():
        try:
            offset = offsets.get(bot["name"], 0)
            result = await tg(bot["token"], "getUpdates", {
                "offset": offset,
                "timeout": POLL_TIMEOUT,
                "allowed_updates": ["message"],
            })

            if result.get("ok") and result.get("result"):
                for update in result["result"]:
                    # Always advance offset — Telegram requires this to stop re-sending
                    offsets[bot["name"]] = update["update_id"] + 1

                    msg = update.get("message")
                    if not msg:
                        continue

                    user_id = str(msg.get("from", {}).get("id", ""))
                    if allowed and user_id not in allowed:
                        log(f"[{bot['name']}] Blocked user {user_id}")
                        continue

                    text = msg.get("text", "")
                    if not text:
                        continue

                    from_user = msg.get("from", {})
                    log(f"[{bot['name']}] Queued from {from_user.get('first_name', user_id)}: \"{text[:60]}\"")
                    await queue.put((bot, msg["chat"]["id"], text, from_user, "telegram", None))

                save_offsets()

        except Exception as e:
            err_str = str(e)
            if "409" in err_str:
                # 409 = residual long-poll conflict, short retry
                await asyncio.sleep(2)
            else:
                log(f"[{bot['name']}] Poll error: {e}. Retrying in {ERROR_RETRY_S}s...")
                await asyncio.sleep(ERROR_RETRY_S)


# --- HTTP API Server (:3460) ---

async def handle_http(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    """Raw HTTP request handler for dashboard API."""
    try:
        # Read request line
        request_line = await asyncio.wait_for(reader.readline(), timeout=10)
        if not request_line:
            writer.close()
            return
        parts = request_line.decode().strip().split(" ")
        if len(parts) < 2:
            writer.close()
            return
        method, raw_path = parts[0], parts[1]

        # Read headers
        content_length = 0
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
            if line in (b"\r\n", b"\n", b""):
                break
            if line.lower().startswith(b"content-length:"):
                content_length = int(line.split(b":")[1].strip())

        # Read body
        body = b""
        if content_length > 0:
            body = await asyncio.wait_for(reader.readexactly(content_length), timeout=10)

        # Parse path and query
        path = raw_path.split("?")[0]
        query_str = raw_path.split("?")[1] if "?" in raw_path else ""
        params = {}
        if query_str:
            for pair in query_str.split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    params[k] = v

        # Route
        await route_http(method, path, params, body, writer)

    except Exception as e:
        log(f"HTTP error: {e}")
        try:
            writer.close()
        except Exception:
            pass


def http_response(writer, status, body_dict, content_type="application/json"):
    """Send a simple HTTP response."""
    body_bytes = json.dumps(body_dict).encode() if isinstance(body_dict, (dict, list)) else body_dict
    writer.write(
        f"HTTP/1.1 {status}\r\n"
        f"Content-Type: {content_type}\r\n"
        f"Content-Length: {len(body_bytes)}\r\n"
        f"Access-Control-Allow-Origin: *\r\n"
        f"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        f"Access-Control-Allow-Headers: Content-Type\r\n"
        f"Connection: close\r\n"
        f"\r\n".encode()
    )
    writer.write(body_bytes)


async def route_http(method, path, params, body, writer):
    """Route HTTP requests to handlers."""

    # CORS preflight
    if method == "OPTIONS":
        http_response(writer, "204 No Content", b"", "text/plain")
        await writer.drain()
        writer.close()
        return

    # GET /api/health
    if path == "/api/health" and method == "GET":
        http_response(writer, "200 OK", {
            "status": "ok",
            "queue_depth": queue.qsize() if queue else 0,
            "bots": len(config.get("bots", [])) if config else 0,
            "uptime_s": int(time.monotonic() - _start_time),
        })
        await writer.drain()
        writer.close()
        return

    # GET /api/agents
    if path == "/api/agents" and method == "GET":
        bots = config.get("bots", []) if config else []
        agents = []
        for bot in bots:
            agents.append({
                "name": bot["name"],
                "displayName": bot.get("displayName"),
                "agentDir": bot["agentDir"],
                "hasTelegram": not bot.get("dashboardOnly", False) and not bot.get("ollamaModel"),
                "backend": "ollama" if bot.get("ollamaModel") else "claude",
                "ollamaModel": bot.get("ollamaModel"),
            })
        http_response(writer, "200 OK", agents)
        await writer.drain()
        writer.close()
        return

    # GET /api/chat/{agent}/history
    history_match = re.match(r"^/api/chat/([a-zA-Z0-9_.-]+)/history$", path)
    if history_match and method == "GET":
        agent_name = history_match.group(1)
        history = load_chat_history(agent_name)
        limit = int(params.get("limit", "100"))
        if limit < len(history["messages"]):
            history["messages"] = history["messages"][-limit:]
        http_response(writer, "200 OK", history)
        await writer.drain()
        writer.close()
        return

    # POST /api/chat/{agent}/new-session — reset conversation (start fresh next message)
    new_session_match = re.match(r"^/api/chat/([a-zA-Z0-9_.-]+)/new-session$", path)
    if new_session_match and method == "POST":
        agent_name = new_session_match.group(1)
        agent_dir = Path(AGENTS_DIR) / agent_name
        if not agent_dir.exists():
            http_response(writer, "404 Not Found", {"error": f"Agent '{agent_name}' not found"})
            await writer.drain()
            writer.close()
            return
        # Delete Claude Code session files so next query() starts fresh
        # Sessions live in {agentDir}/.claude/sessions/
        sessions_dir = agent_dir / ".claude" / "sessions"
        cleared = 0
        if sessions_dir.exists():
            shutil.rmtree(sessions_dir)
            cleared = 1
        log(f"[{agent_name}] New session requested (cleared sessions: {cleared})")
        http_response(writer, "200 OK", {"ok": True, "cleared": cleared})
        await writer.drain()
        writer.close()
        return

    # POST /api/chat/{agent} — enqueue message, return SSE stream
    chat_match = re.match(r"^/api/chat/([a-zA-Z0-9_.-]+)$", path)
    if chat_match and method == "POST":
        agent_name = chat_match.group(1)

        # Find bot config
        bots = config.get("bots", []) if config else []
        bot = None
        for b in bots:
            if b["name"] == agent_name:
                bot = b
                break

        if not bot:
            http_response(writer, "404 Not Found", {"error": f"Agent '{agent_name}' not found"})
            await writer.drain()
            writer.close()
            return

        # Parse message
        try:
            req_body = json.loads(body) if body else {}
        except Exception:
            req_body = {}
        message = req_body.get("message", "")
        if not message:
            http_response(writer, "400 Bad Request", {"error": "Missing 'message' field"})
            await writer.drain()
            writer.close()
            return

        # Create SSE response queue
        sse_q = asyncio.Queue()

        # Enqueue for processing
        from_user = {"first_name": "Dashboard", "id": "dashboard"}
        await queue.put((bot, None, message, from_user, "dashboard", sse_q))
        log(f"[{agent_name}] Dashboard message queued (queue depth: {queue.qsize()})")

        # Send SSE headers
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: text/event-stream\r\n"
            b"Cache-Control: no-cache\r\n"
            b"Access-Control-Allow-Origin: *\r\n"
            b"Connection: keep-alive\r\n"
            b"\r\n"
        )
        await writer.drain()

        # Stream tokens as SSE events with keepalive heartbeats.
        # No hard timeout — queries can run arbitrarily long.
        # Heartbeats every 15s keep the connection alive through proxies/browsers.
        HEARTBEAT_INTERVAL = 15  # seconds
        try:
            while True:
                try:
                    event_type, data = await asyncio.wait_for(
                        sse_q.get(), timeout=HEARTBEAT_INTERVAL
                    )
                except asyncio.TimeoutError:
                    # No event within interval — send SSE comment as keepalive
                    writer.write(b": heartbeat\n\n")
                    await writer.drain()
                    continue
                if event_type == "token":
                    payload = json.dumps({"text": data})
                    writer.write(f"data: {payload}\n\n".encode())
                    await writer.drain()
                elif event_type == "result":
                    writer.write(f"event: result\ndata: {json.dumps({'text': data})}\n\n".encode())
                    await writer.drain()
                elif event_type == "progress":
                    writer.write(f"event: progress\ndata: {json.dumps(data)}\n\n".encode())
                    await writer.drain()
                elif event_type == "done":
                    writer.write(f"event: done\ndata: {json.dumps(data)}\n\n".encode())
                    await writer.drain()
                    break
                elif event_type == "error":
                    writer.write(f"event: error\ndata: {json.dumps({'error': data})}\n\n".encode())
                    await writer.drain()
                    break
        except (ConnectionResetError, BrokenPipeError):
            log("SSE client disconnected")
        except Exception as e:
            log(f"SSE stream error: {e}")

        writer.close()
        return

    # 404
    http_response(writer, "404 Not Found", {"error": "Not found"})
    await writer.drain()
    writer.close()


_start_time = time.monotonic()


# --- Main ---
async def main():
    global queue, shutdown_event, config

    queue = asyncio.Queue()
    shutdown_event = asyncio.Event()

    # Ensure single instance — kill any stale process, acquire lock
    acquire_pidfile()
    atexit.register(release_pidfile)

    log("=== Telegram Bridge starting (Agent SDK) ===")

    # Strip nesting env vars from our own process too
    for var in NESTING_ENV_VARS:
        os.environ.pop(var, None)

    # Load config
    config = json.loads(CONFIG_PATH.read_text())  # noqa: global config
    log(f"Loaded config: {len(config['bots'])} bots, allowed: {config.get('allowedUsers', [])}")

    # Start HTTP API server
    import socket
    http_server = await asyncio.start_server(
        handle_http, "0.0.0.0", HTTP_PORT,
        reuse_address=True,
        reuse_port=True,
        start_serving=True,
    )
    log(f"HTTP API listening on :{HTTP_PORT}")

    # Load tokens (skip dashboardOnly bots — they have no Telegram bot)
    for bot in config["bots"]:
        if bot.get("dashboardOnly"):
            log(f"[{bot['name']}] dashboardOnly — skipping token load")
            bot["token"] = None
            continue
        try:
            bot["token"] = Path(bot["tokenFile"]).read_text().strip()
        except Exception as e:
            log(f"WARN: Cannot read token for {bot['name']}: {e} — skipping Telegram polling")
            bot["token"] = None

    # Delete any existing webhooks (409 Conflict if webhooks are set)
    for bot in config["bots"]:
        if bot.get("dashboardOnly"):
            continue
        try:
            result = await tg(bot["token"], "deleteWebhook", {"drop_pending_updates": False})
            if result.get("ok"):
                log(f"[{bot['name']}] Webhook cleared")
            else:
                log(f"[{bot['name']}] Webhook clear failed: {result}")
        except Exception as e:
            log(f"[{bot['name']}] Webhook clear error: {e}")

    # Load offsets and sessions
    load_offsets()
    log(f"Loaded offsets for {len(offsets)} bots")

    # Signal handlers
    def handle_signal(sig, _):
        log(f"Signal {sig} received. Shutting down...")
        shutdown_event.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # Start processor + pollers (skip dashboardOnly bots — no Telegram to poll)
    tasks = [asyncio.create_task(process_messages(config))]
    for i, bot in enumerate(config["bots"]):
        if bot.get("dashboardOnly"):
            log(f"[{bot['name']}] dashboardOnly — skipping Telegram poll")
            continue
        if i > 0:
            await asyncio.sleep(STAGGER_S)
        log(f"Starting poll: {bot['name']}")
        tasks.append(asyncio.create_task(poll_bot(bot, config)))

    log("=== All bots polling. Bridge ready. ===")

    # Wait for shutdown
    await shutdown_event.wait()
    log("Saving offsets...")
    save_offsets()

    # Close HTTP server
    http_server.close()
    await http_server.wait_closed()

    # Cancel all tasks (including per-agent queue processors)
    all_tasks = tasks + list(_agent_tasks.values())
    for t in all_tasks:
        t.cancel()
    await asyncio.gather(*all_tasks, return_exceptions=True)
    release_pidfile()
    log("=== Bridge stopped. ===")


if __name__ == "__main__":
    asyncio.run(main())
