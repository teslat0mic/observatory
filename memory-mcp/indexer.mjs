#!/usr/bin/env node
/**
 * Memory Indexer — walks agent memory/*.md files and indexes them into SQLite
 * Usage: node indexer.mjs [agent-name]
 * Example: node indexer.mjs main
 */

import { createRequire } from 'module';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import os from 'os';
import http from 'http';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const MEMORY_DIR = process.env.MEMORY_DIR || join(os.homedir(), '.workshop', 'memory');
const AGENTS_DIR = process.env.WORKSHOP_AGENTS_DIR || join(os.homedir(), 'claude-agents');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/v1/embeddings';
const EMBED_MODEL = process.env.EMBED_MODEL || 'embeddinggemma:300m';
const VEC_DYLIB = process.env.VEC_DYLIB || '';
const CHUNK_SIZE = 400; // words per chunk

const agentArg = process.argv[2];

async function embed(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: EMBED_MODEL, input: text });
    const url = new URL(OLLAMA_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 11434,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.data?.[0]?.embedding || json.embedding || null);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function chunkText(text, chunkSize = CHUNK_SIZE) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
  }
  return chunks;
}

function initDb(db, vecDim) {
  if (VEC_DYLIB) {
    try { db.loadExtension(VEC_DYLIB); } catch (e) {
      console.warn('Warning: could not load sqlite-vec, vector search disabled:', e.message);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      file TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(agent, file, chunk_index)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, content=chunks, content_rowid=id);
  `);
  // Try to create vector table
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${vecDim}])`);
  } catch (e) {
    console.warn('Vector table not available (sqlite-vec not loaded)');
  }
}

async function indexAgent(agentName) {
  const memoryDir = join(AGENTS_DIR, agentName, 'memory');
  const dbPath = join(MEMORY_DIR, `${agentName}.sqlite`);

  let files;
  try {
    files = readdirSync(memoryDir).filter(f => f.endsWith('.md'));
  } catch (e) {
    console.error(`No memory dir found for agent '${agentName}' at ${memoryDir}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log(`No .md files in ${memoryDir} — nothing to index`);
    return;
  }

  console.log(`Indexing ${files.length} files for agent: ${agentName}`);

  // Get embedding dimension from first embed
  const testEmbed = await embed('test').catch(() => null);
  const vecDim = testEmbed?.length || 300;

  const db = new Database(dbPath);
  initDb(db, vecDim);

  const deleteChunks = db.prepare(`DELETE FROM chunks WHERE agent = ? AND file = ?`);
  const deleteFts = db.prepare(`DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE agent = ? AND file = ?)`);
  const insertChunk = db.prepare(`INSERT OR REPLACE INTO chunks (agent, file, chunk_index, content) VALUES (?, ?, ?, ?)`);
  const insertFts = db.prepare(`INSERT INTO chunks_fts(rowid, content) VALUES (?, ?)`);
  let deleteVec;
  let insertVec;
  try {
    deleteVec = db.prepare(`DELETE FROM chunks_vec WHERE rowid IN (SELECT id FROM chunks WHERE agent = ? AND file = ?)`);
    insertVec = db.prepare(`INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)`);
  } catch (e) { deleteVec = null; insertVec = null; }

  for (const file of files) {
    const filePath = join(memoryDir, file);
    const content = readFileSync(filePath, 'utf8');
    const chunks = chunkText(content);
    console.log(`  ${file}: ${chunks.length} chunks`);

    // Delete existing rows for this (agent, file) to make re-indexing idempotent
    db.transaction(() => {
      if (deleteVec) deleteVec.run(agentName, file);
      deleteFts.run(agentName, file);
      deleteChunks.run(agentName, file);
    })();

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const info = db.transaction(() => {
        const r = insertChunk.run(agentName, file, i, chunk);
        if (r.lastInsertRowid) {
          insertFts.run(r.lastInsertRowid, chunk);
        }
        return r;
      })();

      if (insertVec && info.lastInsertRowid && testEmbed) {
        try {
          const vec = await embed(chunk);
          if (vec) {
            insertVec.run(info.lastInsertRowid, new Float32Array(vec));
          }
        } catch (e) {
          console.warn(`    Embedding failed for chunk ${i}: ${e.message}`);
        }
      }
    }
  }

  db.close();
  console.log(`Done: ${agentName}`);
}

// Main
if (!agentArg) {
  console.error('Usage: node indexer.mjs <agent-name>');
  console.error('Example: node indexer.mjs main');
  process.exit(1);
}

indexAgent(agentArg).catch(e => { console.error(e); process.exit(1); });
