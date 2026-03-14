#!/usr/bin/env node
// Memory Search MCP Server
// Wraps SQLite memory databases with hybrid vector+BM25 search.
// Uses Ollama for query embeddings and sqlite-vec for vector search.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const MEMORY_DIR  = process.env.MEMORY_DIR  || path.join(os.homedir(), '.workshop', 'memory');
const VEC_DYLIB   = process.env.VEC_DYLIB   || '';  // user must configure — path to sqlite-vec dylib
const OLLAMA_URL  = process.env.OLLAMA_URL  || 'http://localhost:11434/v1/embeddings';
const EMBED_MODEL = process.env.EMBED_MODEL || 'embeddinggemma:300m';

const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;
const MIN_SCORE = 0.15;
const MAX_RESULTS = 10;
const SNIPPET_MAX_CHARS = 700;

// --- Embedding via Ollama ---

async function embedQuery(query) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: query }),
  });
  if (!res.ok) throw new Error(`Ollama embedding failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding; // float64 array, 768 dims
}

// --- Database helpers ---

let vecAvailable = false;

function openDb(agent) {
  const dbPath = path.join(MEMORY_DIR, `${agent}.sqlite`);
  const db = Database(dbPath, { readonly: true });
  if (VEC_DYLIB) {
    try {
      db.loadExtension(VEC_DYLIB);
      vecAvailable = true;
    } catch (e) {
      vecAvailable = false;
      console.error(`[memory-mcp] vec0 extension not loaded: ${e.message} — using keyword-only (FTS5) search`);
    }
  } else {
    vecAvailable = false;
    console.error(`[memory-mcp] VEC_DYLIB not set — using keyword-only (FTS5) search`);
  }
  return db;
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function bm25RankToScore(rank) {
  return 1 / (1 + Math.max(0, rank));
}

function tokenizeQuery(query) {
  return query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"`)
    .join(" AND ");
}

// --- Hybrid search ---

async function hybridSearch(db, queryEmbedding, queryText, sources = ["memory", "sessions"]) {
  const scoreMap = new Map(); // id -> { vectorScore, textScore, chunk }

  // 1. Vector search (only if sqlite-vec is available)
  const candidateLimit = MAX_RESULTS * 5;

  if (vecAvailable && queryEmbedding) {
    try {
      const placeholders = sources.map(() => "?").join(",");
      const vecSql = `
        SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,
               vec_distance_cosine(v.embedding, ?) AS dist
          FROM chunks_vec v
          JOIN chunks c ON c.id = v.id
         WHERE c.model = ?
           AND c.source IN (${placeholders})
         ORDER BY dist ASC
         LIMIT ?
      `;
      // Convert float64 array to Float32Array buffer for vec0
      const f32 = new Float32Array(queryEmbedding);
      const vecRows = db.prepare(vecSql).all(Buffer.from(f32.buffer), EMBED_MODEL, ...sources, candidateLimit);

      for (const row of vecRows) {
        const score = 1 - row.dist;
        scoreMap.set(row.id, {
          vectorScore: score,
          textScore: 0,
          chunk: { id: row.id, path: row.path, startLine: row.start_line, endLine: row.end_line, text: row.text, source: row.source },
        });
      }
    } catch (e) {
      console.error(`[memory-mcp] Vector search failed: ${e.message} — falling back to FTS5-only`);
    }
  } else if (!vecAvailable) {
    console.error(`[memory-mcp] sqlite-vec not available — using keyword-only (FTS5) search`);
  }

  // 2. BM25 keyword search
  const ftsQuery = tokenizeQuery(queryText);
  if (ftsQuery) {
    try {
      const placeholders = sources.map(() => "?").join(",");
      const ftsSql = `
        SELECT id, path, source, start_line, end_line, text,
               bm25(chunks_fts) AS rank
          FROM chunks_fts
         WHERE chunks_fts MATCH ?
           AND model = ?
           AND source IN (${placeholders})
         ORDER BY rank ASC
         LIMIT ?
      `;
      const ftsRows = db.prepare(ftsSql).all(ftsQuery, EMBED_MODEL, ...sources, candidateLimit);

      for (const row of ftsRows) {
        const textScore = bm25RankToScore(Math.abs(row.rank));
        const existing = scoreMap.get(row.id);
        if (existing) {
          existing.textScore = textScore;
        } else {
          scoreMap.set(row.id, {
            vectorScore: 0,
            textScore,
            chunk: { id: row.id, path: row.path, startLine: row.start_line, endLine: row.end_line, text: row.text, source: row.source },
          });
        }
      }
    } catch (e) {
      // FTS query might fail on certain inputs — that's ok, vector-only is fine
      console.error(`[memory-mcp] FTS search failed: ${e.message}`);
    }
  }

  // 3. Merge scores and filter
  const results = [];
  for (const [, entry] of scoreMap) {
    if (vecAvailable) {
      // Hybrid scoring: weighted combination of vector and text scores
      const finalScore = VECTOR_WEIGHT * entry.vectorScore + TEXT_WEIGHT * entry.textScore;
      if (finalScore >= MIN_SCORE) {
        results.push({ ...entry.chunk, score: finalScore });
      }
    } else {
      // FTS5-only fallback: use BM25 text score directly, no vector component
      if (entry.textScore >= MIN_SCORE) {
        results.push({ ...entry.chunk, score: entry.textScore });
      }
    }
  }

  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return results.slice(0, MAX_RESULTS);
}

// --- MCP Server ---

const server = new McpServer({
  name: "memory-search",
  version: "1.0.0",
});

server.tool(
  "memory_search",
  "Semantically search the memory database using hybrid vector + keyword search. Returns the most relevant memory chunks with file paths, line numbers, and relevance scores. Use this before starting work to recall relevant context, past decisions, and lessons learned.",
  {
    query: z.string().describe("Natural language search query"),
    agent: z.string().optional().default("main").describe("Agent database to search (main, etc.)"),
  },
  async ({ query, agent }) => {
    let db;
    try {
      db = openDb(agent);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: Could not open database for agent "${agent}": ${e.message}` }] };
    }

    try {
      const queryEmbedding = vecAvailable ? await embedQuery(query) : null;
      const results = await hybridSearch(db, queryEmbedding, query);

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No results found for "${query}" in ${agent} memory.` }] };
      }

      const formatted = results
        .map((r, i) => {
          const snippet = r.text.length > SNIPPET_MAX_CHARS ? r.text.slice(0, SNIPPET_MAX_CHARS) + "..." : r.text;
          const scoreStr = r.score != null ? r.score.toFixed(3) : 'n/a';
          return `### Result ${i + 1} (score: ${scoreStr})\n**${r.path}** lines ${r.startLine}-${r.endLine}\n\n${snippet}`;
        })
        .join("\n\n---\n\n");

      return { content: [{ type: "text", text: `Found ${results.length} results for "${query}" in ${agent} memory:\n\n${formatted}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Search error: ${e.message}` }] };
    } finally {
      db.close();
    }
  }
);

server.tool(
  "memory_agents",
  "List all available agent memory databases and their chunk counts.",
  {},
  async () => {
    try {
      const files = await readdir(MEMORY_DIR);
      const agents = files.filter((f) => f.endsWith(".sqlite")).map((f) => f.replace(".sqlite", ""));

      const info = agents.map((agent) => {
        try {
          const db = Database(path.join(MEMORY_DIR, `${agent}.sqlite`), { readonly: true });
          const row = db.prepare("SELECT count(*) as cnt FROM chunks").get();
          db.close();
          return `- **${agent}**: ${row.cnt} chunks`;
        } catch {
          return `- **${agent}**: (error reading)`;
        }
      });

      return { content: [{ type: "text", text: `Available memory databases:\n\n${info.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error listing databases: ${e.message}` }] };
    }
  }
);

// Connect
const transport = new StdioServerTransport();
await server.connect(transport);
