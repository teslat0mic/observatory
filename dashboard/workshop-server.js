#!/usr/bin/env node
// Workshop Dashboard Server — zero external dependencies
// Serves workshop.html, file editing API, proxies chat to bridge :3460
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');

const PORT        = parseInt(process.env.WORKSHOP_DASHBOARD_PORT || '3500', 10);
const BRIDGE_URL  = process.env.BRIDGE_URL || 'http://127.0.0.1:3460';
const BRIDGE_HOST = new URL(BRIDGE_URL).hostname;
const BRIDGE_PORT = parseInt(new URL(BRIDGE_URL).port, 10);

const AGENTS_DIR   = process.env.WORKSHOP_AGENTS_DIR || path.join(os.homedir(), 'claude-agents');
const BOTS_JSON    = process.env.WORKSHOP_BOTS_JSON  || path.join(os.homedir(), 'claude-migration', 'bots.json');
const LAUNCH_DIR   = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PROJECTS_DIR = process.env.WORKSHOP_PROJECTS_DIR || path.join(AGENTS_DIR, 'main', 'memory', 'projects');
const HTML_FILE    = path.join(__dirname, 'workshop.html');

// Read bots.json and return a map of name -> {displayName, ollamaModel}
function readBotsMap() {
  try {
    const raw = fs.readFileSync(BOTS_JSON, 'utf8');
    const config = JSON.parse(raw);
    const map = {};
    for (const bot of (config.bots || [])) {
      map[bot.name] = {
        displayName: bot.displayName || null,
        ollamaModel: bot.ollamaModel || null,
      };
    }
    return map;
  } catch { return {}; }
}

// Known protocols — loaded from PROJECTS_DIR status files.
// To customize, populate {key}-status.json files in PROJECTS_DIR,
// or set WORKSHOP_KNOWN_PROTOCOLS env var as JSON.
const KNOWN_PROTOCOLS = process.env.WORKSHOP_KNOWN_PROTOCOLS
  ? JSON.parse(process.env.WORKSHOP_KNOWN_PROTOCOLS)
  : [
      { key: 'nightwatch',   name: 'NIGHTWATCH',   desc: 'Autonomous builds' },
      { key: 'gauntlet',     name: 'GAUNTLET',     desc: 'Error sweep' },
      { key: 'paramedic',    name: 'PARAMEDIC',    desc: 'Error triage' },
    ];

// --- Safety ---
const BLOCKED_PATTERNS = ['config.php', '.env', 'secrets/', 'settings.json', 'settings.local.json'];

function isPathSafe(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(AGENTS_DIR)) return false;
  const lower = resolved.toLowerCase();
  for (const pat of BLOCKED_PATTERNS) {
    if (lower.includes(pat)) return false;
  }
  return true;
}

// --- Helpers ---
function jsonRes(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- Bridge agent lookup (cached, refreshed every 15s) ---
let bridgeAgentMap = {}; // name -> {hasTelegram}
let bridgeCacheTs = 0;
let bridgeOnline = false;
let bridgeRefreshing = false;

function refreshBridgeAgents() {
  if (bridgeRefreshing) return Promise.resolve();
  bridgeRefreshing = true;
  return new Promise((resolve) => {
    const options = { hostname: BRIDGE_HOST, port: BRIDGE_PORT, path: '/api/agents', method: 'GET' };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const map = {};
          for (const a of data) map[a.name] = { hasTelegram: a.hasTelegram === true };
          bridgeAgentMap = map;
          bridgeCacheTs = Date.now();
          bridgeOnline = true;
        } catch {
          bridgeOnline = false;
        }
        bridgeRefreshing = false;
        resolve();
      });
    });
    req.on('error', () => {
      bridgeOnline = false;
      bridgeRefreshing = false;
      resolve();
    });
    req.setTimeout(2000, () => { req.destroy(); bridgeOnline = false; bridgeRefreshing = false; resolve(); });
    req.end();
  });
}

async function getBridgeAgentMap() {
  if (Date.now() - bridgeCacheTs > 15000) await refreshBridgeAgents();
  return bridgeAgentMap;
}

// --- Inbox file count (excludes 'processed' subdir) ---
function countInboxFiles(inboxPath) {
  try {
    return fs.readdirSync(inboxPath, { withFileTypes: true })
      .filter(e => e.isFile())
      .length;
  } catch { return 0; }
}

// --- Last active timestamp from chat-history.json ---
async function getLastActive(agentPath) {
  const histPath = path.join(agentPath, 'chat-history.json');
  try {
    const raw = await fs.promises.readFile(histPath, 'utf8');
    const data = JSON.parse(raw);
    const msgs = Array.isArray(data) ? data : (data.messages || []);
    if (msgs.length) {
      const last = msgs[msgs.length - 1];
      if (last.ts) return last.ts;
    }
    // Fall back to file mtime
    const stat = await fs.promises.stat(histPath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

// --- Agent scanning ---
async function listAgents() {
  const bridgeMap = await getBridgeAgentMap();
  const botsMap = readBotsMap();
  const agents = [];
  try {
    const dirs = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const agentPath = path.join(AGENTS_DIR, d.name);
      let fileCount = 0;
      try {
        const walk = (dir) => {
          for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            if (f.isFile()) fileCount++;
            else if (f.isDirectory() && f.name !== '.git' && f.name !== 'node_modules') {
              walk(path.join(dir, f.name));
            }
          }
        };
        walk(agentPath);
      } catch {}
      const inboxPath = path.join(agentPath, 'inbox');
      const hasInbox = fs.existsSync(inboxPath);
      const inboxCount = hasInbox ? countInboxFiles(inboxPath) : 0;
      const bridgeInfo = bridgeMap[d.name] || null;
      const botsInfo = botsMap[d.name] || null;
      agents.push({
        name: d.name,
        displayName: botsInfo ? botsInfo.displayName : null,
        ollamaModel: botsInfo ? botsInfo.ollamaModel : null,
        path: agentPath,
        fileCount,
        hasClaude: fs.existsSync(path.join(agentPath, 'CLAUDE.md')),
        hasMemory: fs.existsSync(path.join(agentPath, 'memory')),
        hasInbox,
        inboxCount,
        hasTelegram: bridgeInfo ? bridgeInfo.hasTelegram : false,
        lastActive: await getLastActive(agentPath),
      });
    }
  } catch (e) {
    log(`Error scanning agents: ${e.message}`);
  }
  return { bridgeOnline, agents: agents.sort((a, b) => a.name.localeCompare(b.name)) };
}

function listAgentFiles(agentName) {
  const agentPath = path.join(AGENTS_DIR, agentName);
  if (!fs.existsSync(agentPath)) return null;

  const files = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        const stat = fs.statSync(full);
        files.push({ name: rel, path: full, size: stat.size, mtime: stat.mtime.toISOString() });
      } else if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') {
        walk(full, rel);
      }
    }
  };
  walk(agentPath, '');

  // Pin CLAUDE.md at top
  files.sort((a, b) => {
    if (a.name === 'CLAUDE.md') return -1;
    if (b.name === 'CLAUDE.md') return 1;
    return a.name.localeCompare(b.name);
  });
  return files;
}

// --- Bridge proxy ---
function proxyToBridge(method, bridgePath, reqBody, res, isSSE = false) {
  const options = {
    hostname: BRIDGE_HOST,
    port: BRIDGE_PORT,
    path: bridgePath,
    method: method,
    headers: {},
  };
  if (reqBody) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = Buffer.byteLength(reqBody);
  }

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (proxyRes.headers['content-type']) {
      headers['Content-Type'] = proxyRes.headers['content-type'];
    }
    if (proxyRes.headers['cache-control']) {
      headers['Cache-Control'] = proxyRes.headers['cache-control'];
    }

    if (isSSE) {
      // SSE: flush headers immediately, forward chunks without buffering
      headers['Content-Type'] = 'text/event-stream';
      headers['Cache-Control'] = 'no-cache';
      headers['Connection'] = 'keep-alive';
      headers['X-Accel-Buffering'] = 'no';  // nginx hint
      res.writeHead(proxyRes.statusCode, headers);
      res.flushHeaders();
      // Disable Nagle on both sockets so tokens/heartbeats flush immediately
      if (res.socket) res.socket.setNoDelay(true);
      // Abort upstream if client disconnects
      res.on('close', () => { proxyReq.destroy(); });
      proxyRes.on('data', (chunk) => {
        if (!res.destroyed) res.write(chunk);
      });
      proxyRes.on('end', () => {
        if (!res.destroyed) res.end();
      });
    } else {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    }
  });

  // Disable Nagle on upstream socket
  proxyReq.on('socket', (sock) => sock.setNoDelay(true));

  // Timeout: 10 min ceiling for long-running agent queries
  proxyReq.setTimeout(600_000, () => {
    log('Bridge proxy timeout (10min) — destroying upstream request');
    proxyReq.destroy(new Error('upstream timeout'));
  });

  proxyReq.on('error', (e) => {
    log(`Bridge proxy error: ${e.message}`);
    if (res.headersSent) {
      // Mid-stream error: send SSE error frame before closing
      if (!res.destroyed) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
      }
      res.end();
      return;
    }
    jsonRes(res, 502, { error: 'Bridge unavailable', detail: e.message });
  });

  if (reqBody) proxyReq.write(reqBody);
  proxyReq.end();
}

// --- Protocol status (reads {key}-status.json files) ---
function readProtocols() {
  return KNOWN_PROTOCOLS.map(p => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, `${p.key}-status.json`), 'utf8'));
      return { ...p, ...data };
    } catch {
      return { ...p, last_run: null, status: 'never', summary: p.desc, targets: [], duration_s: null };
    }
  });
}

// --- Cron status (reads launchd plists + launchctl list) ---
function formatCalSchedule(cal) {
  if (!cal) return 'scheduled';
  const arr = Array.isArray(cal) ? cal : [cal];
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return arr.map(c => {
    const hh = String(c.Hour   !== undefined ? c.Hour   : 0).padStart(2, '0');
    const mm = String(c.Minute !== undefined ? c.Minute : 0).padStart(2, '0');
    return c.Weekday !== undefined ? `${days[c.Weekday]} ${hh}:${mm}` : `${hh}:${mm}`;
  }).join(', ');
}

function readCrons() {
  const crons = [];
  let launchctlMap = {};
  try {
    const out = execSync('launchctl list 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && parts[2].startsWith('com.workshop.')) {
        launchctlMap[parts[2]] = { pid: parts[0], lastExit: parseInt(parts[1], 10) };
      }
    }
  } catch {}

  let files = [];
  try { files = fs.readdirSync(LAUNCH_DIR).filter(f => f.startsWith('com.workshop.') && f.endsWith('.plist')); }
  catch {}

  for (const file of files) {
    const label = file.replace('.plist', '');
    const name  = label.replace('com.workshop.', '');
    try {
      const jsonStr = execSync(`plutil -convert json -o - "${path.join(LAUNCH_DIR, file)}"`, { encoding: 'utf8', timeout: 3000 });
      const plist = JSON.parse(jsonStr);
      let scheduleHuman = 'always running';
      let scheduleType  = 'daemon';
      if (plist.StartInterval) {
        const s = plist.StartInterval;
        scheduleHuman = s < 120 ? `every ${s}s` : s < 3600 ? `every ${Math.round(s/60)}m` : `every ${Math.round(s/3600)}h`;
        scheduleType = 'interval';
      } else if (plist.StartCalendarInterval) {
        scheduleHuman = formatCalSchedule(plist.StartCalendarInterval);
        scheduleType = 'calendar';
      }
      const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
      const script = (plist.Program || args[0] || '').split('/').pop();
      const lctl = launchctlMap[label] || {};
      const running = lctl.pid && lctl.pid !== '-';
      const loaded = !!launchctlMap[label];
      const lastExit = lctl.lastExit !== undefined ? lctl.lastExit : null;
      // Calendar times (raw) for timeline positioning
      let calendarTimes = [];
      if (plist.StartCalendarInterval) {
        const arr = Array.isArray(plist.StartCalendarInterval) ? plist.StartCalendarInterval : [plist.StartCalendarInterval];
        calendarTimes = arr.map(c => ({
          hour: c.Hour !== undefined ? c.Hour : 0,
          minute: c.Minute !== undefined ? c.Minute : 0,
          weekday: c.Weekday !== undefined ? c.Weekday : null,
        }));
      }
      // Last run time from log file mtime
      let lastRunTs = null;
      const logFile = (plist.StandardOutPath || '').replace(/^~/, os.homedir());
      if (logFile) { try { lastRunTs = fs.statSync(logFile).mtime.toISOString(); } catch {} }
      crons.push({ label, name, script, scheduleType, scheduleHuman, running: !!running, loaded, lastExit, keepAlive: !!plist.KeepAlive, calendarTimes, lastRunTs });
    } catch {}
  }
  return crons.sort((a, b) => a.name.localeCompare(b.name));
}

// --- Routes ---
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // Serve UI
  if (p === '/' || p === '/index.html' || p === '/workshop.html') {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    } catch {
      res.writeHead(500);
      return res.end('workshop.html not found');
    }
  }

  if (p === '/augmented.css') {
    try {
      const css = fs.readFileSync(path.join(__dirname, 'augmented.css'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'max-age=86400' });
      return res.end(css);
    } catch { res.writeHead(404); return res.end('not found'); }
  }

  if (p === '/command-center.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'command-center.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    } catch {
      res.writeHead(500);
      return res.end('command-center.html not found');
    }
  }

  // --- File Editing API ---

  // GET /api/agents — list all agents with metadata
  if (p === '/api/agents' && method === 'GET') {
    return jsonRes(res, 200, await listAgents());
  }

  // GET /api/agents/{name}/files — file tree
  const filesMatch = p.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/files$/);
  if (filesMatch && method === 'GET') {
    const files = listAgentFiles(filesMatch[1]);
    if (!files) return jsonRes(res, 404, { error: 'Agent not found' });
    return jsonRes(res, 200, files);
  }

  // GET /api/file?path= — read file
  if (p === '/api/file' && method === 'GET') {
    const filePath = url.searchParams.get('path');
    if (!filePath) return jsonRes(res, 400, { error: 'Missing path param' });
    if (!isPathSafe(filePath)) return jsonRes(res, 403, { error: 'Path not allowed' });
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(content);
    } catch (e) {
      return jsonRes(res, 404, { error: e.message });
    }
  }

  // PUT /api/file?path= — write file
  if (p === '/api/file' && method === 'PUT') {
    const filePath = url.searchParams.get('path');
    if (!filePath) return jsonRes(res, 400, { error: 'Missing path param' });
    if (!isPathSafe(filePath)) return jsonRes(res, 403, { error: 'Path not allowed' });
    try {
      const body = await readBody(req);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body);
      log(`File saved: ${filePath} (${body.length} bytes)`);
      return jsonRes(res, 200, { ok: true, size: body.length });
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // --- Chat Proxy (forward to bridge) ---

  // POST /api/chat/{agent} — SSE stream proxy
  const chatMatch = p.match(/^\/api\/chat\/([a-zA-Z0-9_.-]+)$/);
  if (chatMatch && method === 'POST') {
    const body = await readBody(req);
    proxyToBridge('POST', `/api/chat/${chatMatch[1]}`, body, res, true);
    return;
  }

  // GET /api/chat/{agent}/history
  const histMatch = p.match(/^\/api\/chat\/([a-zA-Z0-9_.-]+)\/history$/);
  if (histMatch && method === 'GET') {
    const limit = url.searchParams.get('limit') || '100';
    proxyToBridge('GET', `/api/chat/${histMatch[1]}/history?limit=${limit}`, null, res);
    return;
  }

  // POST /api/chat/{agent}/new-session
  const newSessMatch = p.match(/^\/api\/chat\/([a-zA-Z0-9_.-]+)\/new-session$/);
  if (newSessMatch && method === 'POST') {
    proxyToBridge('POST', `/api/chat/${newSessMatch[1]}/new-session`, null, res);
    return;
  }

  // GET /api/bridge/health
  if (p === '/api/bridge/health' && method === 'GET') {
    proxyToBridge('GET', '/api/health', null, res);
    return;
  }

  // POST /api/bridge/restart — kill old bridge, wait for port release, launchd restarts it
  if (p === '/api/bridge/restart' && method === 'POST') {
    try {
      const pidFile = path.join(os.homedir(), '.claude', 'state', 'telegram-bridge.pid');
      let targetPid = 0;

      // Find the bridge PID
      try {
        targetPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      } catch {
        // Fallback: find by port
        try {
          const out = execSync(`lsof -ti :${BRIDGE_PORT}`, { timeout: 3000 }).toString().trim();
          if (out) targetPid = parseInt(out.split('\n')[0], 10);
        } catch {}
      }

      if (!targetPid) {
        return jsonRes(res, 200, { ok: true, killed: false, note: 'No bridge process found' });
      }

      // SIGTERM and wait for process to die (up to 5s)
      try { process.kill(targetPid, 'SIGTERM'); } catch {}
      log(`Bridge restart: sent SIGTERM to PID ${targetPid}`);

      let dead = false;
      for (let i = 0; i < 50; i++) {
        execSync('sleep 0.1');
        try { process.kill(targetPid, 0); } catch { dead = true; break; }
      }

      // Force kill if still alive
      if (!dead) {
        try { process.kill(targetPid, 'SIGKILL'); } catch {}
        execSync('sleep 0.5');
        log(`Bridge restart: force-killed PID ${targetPid}`);
      }

      // Reset bridge cache
      bridgeOnline = false;
      bridgeCacheTs = 0;

      // launchd KeepAlive will relaunch — wait up to 15s for it to come back
      let restarted = false;
      for (let i = 0; i < 30; i++) {
        execSync('sleep 0.5');
        try {
          const check = http.get(`http://${BRIDGE_HOST}:${BRIDGE_PORT}/api/health`);
          await new Promise((resolve, reject) => {
            check.on('response', (r) => {
              const chunks = [];
              r.on('data', c => chunks.push(c));
              r.on('end', () => {
                try {
                  const data = JSON.parse(Buffer.concat(chunks).toString());
                  if (data.status === 'ok') { restarted = true; }
                } catch {}
                resolve();
              });
            });
            check.on('error', () => resolve());
            check.setTimeout(1000, () => { check.destroy(); resolve(); });
          });
          if (restarted) break;
        } catch {}
      }

      log(`Bridge restart: ${restarted ? 'bridge is back' : 'bridge not yet responding'}`);
      return jsonRes(res, 200, { ok: true, killed: true, restarted });
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // GET /api/protocols — protocol run status
  if (p === '/api/protocols' && method === 'GET') {
    return jsonRes(res, 200, readProtocols());
  }

  // GET /api/crons — launchd workshop job status
  if (p === '/api/crons' && method === 'GET') {
    return jsonRes(res, 200, readCrons());
  }

  // POST /api/crons/:name/stop — unload a launchd job
  // POST /api/crons/:name/start — load a launchd job
  const cronMatch = p.match(/^\/api\/crons\/([a-zA-Z0-9_-]+)\/(stop|start)$/);
  if (cronMatch && method === 'POST') {
    const name = cronMatch[1];
    const action = cronMatch[2];
    const plistFile = path.join(LAUNCH_DIR, `com.workshop.${name}.plist`);

    if (!fs.existsSync(plistFile)) {
      return jsonRes(res, 404, { error: `Plist not found: com.workshop.${name}.plist` });
    }

    const cmd = action === 'stop'
      ? `launchctl unload "${plistFile}"`
      : `launchctl load "${plistFile}"`;

    try {
      execSync(cmd, { encoding: 'utf8', timeout: 5000 });
      log(`Cron ${action}: com.workshop.${name}`);
      return jsonRes(res, 200, { ok: true });
    } catch (e) {
      log(`Cron ${action} failed: ${e.message}`);
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // 404
  jsonRes(res, 404, { error: 'Not found' });
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  log(`Workshop server running on http://localhost:${PORT}`);
});
