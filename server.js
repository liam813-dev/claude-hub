#!/usr/bin/env node
'use strict';

// Local dashboard for terminal coding sessions (Claude Code + Codex).
// Read-only over ~/.claude and ~/.codex. Its own state lives in ~/.session-dashboard.
// Binds to 127.0.0.1 only. No dependencies.

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');

const PORT = Number(process.env.SESSIONS_PORT || 4517);
const HOST = '127.0.0.1';
const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CLAUDE_LIVE = path.join(HOME, '.claude', 'sessions');
const CODEX_DIR = path.join(HOME, '.codex');
const STATE_DIR = path.join(HOME, '.session-dashboard');
const INDEX_FILE = path.join(STATE_DIR, 'index.json');
const META_FILE = path.join(STATE_DIR, 'meta.json');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- config: tags ----------

const DEFAULT_CONFIG = {
  // Optional. Each tag: name, match (case-insensitive regex tested against folder, title and
  // your prompts), color, and an optional weight. The tag with the most hits wins.
  // Example: { "name": "Board", "match": "board|quarterly|investor", "color": "#2f6fdd" }
  // With no tags, every chat is simply listed by date.
  tags: [],
};

let config = DEFAULT_CONFIG;
let rules = [];

function loadConfig() {
  let raw = null;
  try { raw = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') {
      config = DEFAULT_CONFIG;
      try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2)); } catch {}
    }
  }
  if (raw !== null) {
    // A typo in the file keeps the last good tags instead of resetting them.
    try { config = JSON.parse(raw); } catch (err) { console.error('config.json has an error, keeping the previous tags:', err.message); }
  }
  rules = [];
  for (const t of config.tags || []) {
    const color = /^#[0-9a-f]{3,8}$/i.test(String(t.color || '')) ? t.color : '#64748b';
    try { rules.push({ name: t.name, re: new RegExp(t.match, 'gi'), weight: t.weight || 1, color }); } catch {}
  }
}

function autoTag(text, cwd) {
  let best = 'Untagged';
  let bestScore = 0;
  for (const r of rules) {
    const hits = text.match(r.re);
    let score = (hits ? hits.length : 0) * r.weight;
    if (cwd && cwd.match(r.re)) score += 6;
    if (score > bestScore) { bestScore = score; best = r.name; }
  }
  return best;
}

// ---------- small helpers ----------

function parseLoose(s) {
  s = String(s).trim();
  for (let i = 0; i < 4 && s; i++) {
    try { return JSON.parse(s); } catch { s = s.slice(0, -1).trimEnd(); }
  }
  return null;
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}

const writeChains = new Map();
let tmpCounter = 0;
function writeAtomic(file, data) {
  // One write at a time per file, each through its own temp file.
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const tmp = file + '.tmp-' + process.pid + '-' + ++tmpCounter;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  });
  writeChains.set(file, next);
  return next;
}

// Local calendar date (YYYY-MM-DD), not UTC, for folder names.
function localDate(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Stream a JSONL file line by line as Buffers, starting at a byte offset.
// Returns the offset just past the last complete line.
async function scanLines(file, from, onLine) {
  const fh = await fsp.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const CH = 4 << 20;
    const buf = Buffer.allocUnsafe(CH);
    let pos = from;
    let done = from;
    let carry = [];
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, CH, pos);
      if (!bytesRead) break;
      const view = buf.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = view.indexOf(10, start);
        if (nl === -1) break;
        let line = view.subarray(start, nl);
        if (carry.length) { carry.push(Buffer.from(line)); line = Buffer.concat(carry); carry = []; }
        if (line.length > 2) onLine(line);
        start = nl + 1;
        done = pos + start;
      }
      if (start < bytesRead) carry.push(Buffer.from(view.subarray(start)));
      pos += bytesRead;
    }
    return done;
  } finally {
    await fh.close();
  }
}

// ---------- Claude Code: reading prompts out of a transcript line ----------

const QUIET_COMMANDS = /^\/(clear|exit|quit|resume|model|config|status|login|logout|fast|compact|usage|cost|help|mcp|plugin|plugins|permissions|memory|doctor|context|rename|effort|agents|hooks|statusline|artifacts|workflows)$/;

function plainUserText(o) {
  const c = o && o.message && o.message.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
  return '';
}

function humanText(o) {
  if (!o || o.type !== 'user' || o.isMeta || o.isSidechain || o.isCompactSummary) return null;
  if (o.origin && o.origin.kind && o.origin.kind !== 'human') return null;
  const c = o.message && o.message.content;
  let t = '';
  let images = 0;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (!b) continue;
      if (b.type === 'tool_result') return null;
      if (b.type === 'image') images++;
      if (b.type === 'text' && typeof b.text === 'string') t += (t ? '\n' : '') + b.text;
    }
  }
  t = t.trim();
  if (!t) return images ? (images === 1 ? '[image]' : '[' + images + ' images]') : null;
  if (images) t += images === 1 ? ' [image]' : ' [' + images + ' images]';
  const cmd = t.match(/<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/);
  if (cmd) {
    const args = ((t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '').trim();
    const name = cmd[1].startsWith('/') ? cmd[1] : '/' + cmd[1];
    if (QUIET_COMMANDS.test(name)) return null;
    return (name + ' ' + args).trim();
  }
  if (/^<(local-command|task-notification|system-reminder|bash-|user-prompt-submit-hook|command-message)/.test(t)) return null;
  if (/^(Caveat: The messages below|\[Request interrupted|This session is being continued from a previous)/.test(t)) return null;
  return t;
}

function lineKind(line) {
  const head = line.latin1Slice(0, Math.min(line.length, 700));
  if (head.startsWith('{"parentUuid"')) {
    if (head.includes('"type":"user"')) {
      if (head.includes('"tool_use_id"') || head.includes('"type":"tool_result"')) return 'tool-result';
      return 'user';
    }
    // Assistant lines carry the message first and the type field late, so look for the role.
    if (head.includes('"role":"assistant"') || head.includes('"type":"assistant"')) return 'assistant';
    return null;
  }
  if (head.startsWith('{"type":"ai-title"')) return 'ai-title';
  if (head.startsWith('{"type":"custom-title"')) return 'custom-title';
  if (head.startsWith('{"type":"pr-link"')) return 'pr-link';
  return null;
}

// ---------- Claude Code: incremental index ----------

let index = { v: 7, files: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  if (loaded && loaded.v === 7) index = loaded;
} catch {}

const MAX_PROMPTS = 400;

function freshEntry(file) {
  return {
    id: path.basename(file, '.jsonl'), size: 0, mtimeMs: 0, offset: 0,
    aiTitle: '', customTitle: '', startCwd: '', cwd: '', branch: '',
    firstTs: 0, lastPromptTs: 0, turns: 0, prompts: [], promptTs: [], prs: [],
    lastAssistantTs: 0, tail: [],
    ctx: 0, peakCtx: 0, model: '', skills: {},
    lastTool: null, pending: {}, permMode: '',
  };
}

async function scanClaudeFile(file, st) {
  let e = index.files[file];
  if (!e || st.size < e.offset) e = freshEntry(file);
  const end = await scanLines(file, e.offset, (line) => {
    const kind = lineKind(line);
    if (!kind) return;
    if (kind === 'tool-result') {
      // Tool calls that got an answer are no longer waiting on anything.
      if (e.pending && Object.keys(e.pending).length) {
        const txt = line.latin1Slice(0, Math.min(line.length, 400000));
        for (const m of txt.matchAll(/"tool_use_id":"([A-Za-z0-9_-]+)"/g)) delete e.pending[m[1]];
      }
      return;
    }
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    if (kind === 'assistant') {
      const c = o.message && o.message.content;
      if (o.type !== 'assistant' || o.isSidechain || !Array.isArray(c)) return;
      const ts = Date.parse(o.timestamp) || 0;
      const m = o.message;
      // Context size of the request that produced this reply: everything sent in, cached or not.
      const u = m.usage;
      if (u && typeof u.input_tokens === 'number') {
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (ctx > 0) { e.ctx = ctx; if (ctx > e.peakCtx) e.peakCtx = ctx; }
      }
      if (m.model && !String(m.model).startsWith('<')) e.model = m.model;
      if (typeof o.effort === 'string' && o.effort) e.effort = o.effort;
      for (const b of c) {
        if (b && b.type === 'tool_use' && b.id) {
          const label = toolLabel(b.name, b.input);
          e.lastTool = { ...label, ts };
          e.pending = e.pending || {};
          e.pending[b.id] = { ...label, ts };
          const ids = Object.keys(e.pending);
          if (ids.length > 20) delete e.pending[ids[0]];
        }
        if (b && b.type === 'tool_use' && b.name === 'Skill' && b.input && typeof b.input.skill === 'string') {
          const k = b.input.skill.slice(0, 80);
          const prev = e.skills[k] || [0, 0];
          e.skills[k] = [prev[0] + 1, ts || prev[1]];
        }
      }
      for (const b of c) {
        if (!b || b.type !== 'text' || !b.text || !b.text.trim()) continue;
        if (ts) e.lastAssistantTs = ts;
        e.tail.push({ t: b.text.slice(0, 2500), ts });
        if (e.tail.length > 3) e.tail.shift();
      }
      return;
    }
    if (kind === 'ai-title') { if (o.aiTitle) e.aiTitle = clip(o.aiTitle, 120); return; }
    if (kind === 'custom-title') { const t = o.customTitle || o.title; if (t) e.customTitle = clip(t, 120); return; }
    if (kind === 'pr-link') { if (/^https:\/\//.test(o.prUrl || '') && !e.prs.includes(o.prUrl)) e.prs.push(o.prUrl); return; }
    const raw = plainUserText(o);
    if (o.permissionMode) e.permMode = o.permissionMode;
    if (o.type === 'user' && /^\[Request interrupted/.test(raw)) e.pending = {};
    const t = humanText(o);
    if (!t) return;
    e.pending = {};
    const ts = Date.parse(o.timestamp) || 0;
    if (!e.firstTs) e.firstTs = ts;
    if (ts) e.lastPromptTs = ts;
    if (o.cwd) { if (!e.startCwd) e.startCwd = o.cwd; e.cwd = o.cwd; }
    if (o.gitBranch) e.branch = o.gitBranch;
    e.turns++;
    e.prompts.push(clip(t, 240));
    e.promptTs.push(ts);
    if (e.prompts.length > MAX_PROMPTS) { e.prompts.splice(1, 1); e.promptTs.splice(1, 1); }
  });
  e.offset = end;
  e.size = st.size;
  e.mtimeMs = st.mtimeMs;
  index.files[file] = e;
}

let scanning = null;
let lastScan = 0;
let scanProgress = { done: 0, total: 0 };

function scanClaude() {
  if (scanning) return scanning;
  scanning = (async () => {
    const seen = new Set();
    const todo = [];
    let dirs = [];
    try { dirs = await fsp.readdir(CLAUDE_PROJECTS, { withFileTypes: true }); } catch {}
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(CLAUDE_PROJECTS, d.name);
      let names = [];
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl') || !UUID.test(n.slice(0, -6))) continue;
        const file = path.join(dir, n);
        let st;
        try { st = await fsp.stat(file); } catch { continue; }
        seen.add(file);
        const e = index.files[file];
        if (!e || e.size !== st.size || e.mtimeMs !== st.mtimeMs) todo.push([file, st]);
      }
    }
    for (const f of Object.keys(index.files)) if (!seen.has(f)) delete index.files[f];
    scanProgress = { done: 0, total: todo.length };
    for (const [file, st] of todo) {
      try { await scanClaudeFile(file, st); } catch {}
      scanProgress.done++;
    }
    if (todo.length) { try { await writeAtomic(INDEX_FILE, JSON.stringify(index)); } catch {} }
    lastScan = Date.now();
  })().finally(() => { scanning = null; });
  return scanning;
}

// ---------- Codex: thread list straight from its own database ----------

let codexCache = { at: 0, rows: [] };

function codexDbPath() {
  try {
    const files = fs.readdirSync(CODEX_DIR).filter((f) => /^state_\d+\.sqlite$/.test(f));
    files.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    return files.length ? path.join(CODEX_DIR, files[0]) : null;
  } catch { return null; }
}

function loadCodex() {
  if (Date.now() - codexCache.at < 15000) return codexCache.rows;
  const rows = [];
  const dbPath = codexDbPath();
  if (dbPath) {
    let db;
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(dbPath, { readOnly: true });
      for (const r of db.prepare("select * from threads where source not like '{%'").all()) {
        if (r.attached_thread_parent_id) continue;
        // IDs go into the page and into a typed `codex resume` command, so only plain IDs.
        if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(r.id || ''))) continue;
        const first = r.first_user_message || r.title || r.preview || '';
        if (!first && !r.name) continue;
        rows.push({
          id: r.id,
          name: r.name || '',
          first: clip(first, 300),
          hay: clip((r.name || '') + ' ' + first, 2000),
          cwd: r.cwd || '',
          branch: r.git_branch || '',
          created: Number(r.created_at_ms) || Number(r.created_at) * 1000 || 0,
          updated: Number(r.updated_at_ms) || Number(r.updated_at) * 1000 || 0,
          archived: !!r.archived,
          rollout: r.rollout_path || '',
          origin: r.source || '',
        });
      }
    } catch (err) {
      console.error('codex db:', err.message);
    } finally {
      try { db && db.close(); } catch {}
    }
  }
  codexCache = { at: Date.now(), rows };
  return rows;
}

// ---------- live sessions (what is open in a terminal right now) ----------

async function getLive() {
  let names = [];
  try { names = await fsp.readdir(CLAUDE_LIVE); } catch { return []; }
  const regs = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let o;
    try { o = parseLoose(await fsp.readFile(path.join(CLAUDE_LIVE, n), 'utf8')); } catch { continue; }
    if (!o || !o.pid || !o.sessionId) continue;
    if (o.kind && o.kind !== 'interactive') continue; // background replies are not tabs
    try { process.kill(o.pid, 0); } catch { continue; }
    regs.push(o);
  }
  if (!regs.length) return [];
  const ps = await run('/bin/ps', ['-o', 'pid=,tty=,comm=', '-p', regs.map((r) => r.pid).join(',')]);
  const byPid = {};
  for (const l of ps.out.split('\n')) {
    const m = l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (m) byPid[m[1]] = { tty: m[2], comm: m[3] };
  }
  const live = [];
  for (const r of regs) {
    const p = byPid[r.pid];
    if (!p || !/claude/i.test(p.comm)) continue;
    live.push({
      pid: r.pid,
      id: r.sessionId,
      cwd: r.cwd || '',
      status: r.status || 'idle',
      since: r.statusUpdatedAt || r.updatedAt || r.startedAt || 0,
      started: r.startedAt || 0,
      tty: /^ttys\d+$/.test(p.tty) ? p.tty : '',
      bg: r.entrypoint === 'sdk-cli' || !/^ttys\d+$/.test(p.tty),
    });
  }
  return live;
}

// ---------- user state (titles, tags, pins, notes) ----------

let meta = {};
try { meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8')) || {}; } catch {}

async function setMeta(id, patch) {
  const m = { ...(meta[id] || {}) };
  for (const k of ['title', 'tag', 'note']) {
    if (k in patch) { const v = clip(patch[k], k === 'note' ? 600 : 140); if (v) m[k] = v; else delete m[k]; }
  }
  for (const k of ['pinned', 'archived']) {
    if (k in patch) { if (patch[k]) m[k] = true; else delete m[k]; }
  }
  if ('seen' in patch) { const v = Number(patch.seen); if (v > 0) m.seen = v; else delete m.seen; }
  if (Object.keys(m).length) meta[id] = m; else delete meta[id];
  await writeAtomic(META_FILE, JSON.stringify(meta, null, 1));
}

// Delete a chat from the list. Nothing is erased: a Claude transcript (and its folder of
// subagent files, if any) moves to ~/.session-dashboard/trash/<date>/<project>/, where it
// can be moved back by hand. Codex threads live in Codex's own database, so those are only
// hidden here. A chat open in a tab is closed first (tab included).
const TRASH_DIR = path.join(STATE_DIR, 'trash');
async function deleteSession(b) {
  const id = b.id || '';
  if (!UUID.test(id)) return { ok: false, error: 'bad id' };
  // A chat that is still open (a Terminal tab or a background reply) gets closed first,
  // the same way the Close button does it, so deleting here also shuts its tab.
  let closed = '';
  if ((await getLive()).some((l) => l.id === id)) {
    const c = await closeSession(id, !!b.force);
    if (!c.ok) return c;
    closed = c.closed;
    for (let i = 0; i < 20 && ((await getLive()).some((l) => l.id === id) || (runs.has(id) && !runs.get(id).done)); i++) await new Promise((r) => setTimeout(r, 250));
  }
  if (runs.has(id) && !runs.get(id).done) return { ok: false, error: 'That chat is still replying in the background. Stop it first.' };
  if (b.src === 'codex') {
    meta[id] = { ...(meta[id] || {}), deleted: true };
    await writeAtomic(META_FILE, JSON.stringify(meta, null, 1));
    return { ok: true, closed, note: 'Hidden from the Hub. Codex keeps its own copy.' };
  }
  const file = Object.keys(index.files).find((f) => index.files[f].id === id);
  if (!file) return { ok: false, error: 'Transcript not found.' };
  const date = localDate();
  const dest = path.join(TRASH_DIR, date, path.basename(path.dirname(file)));
  await fsp.mkdir(dest, { recursive: true });
  await fsp.rename(file, path.join(dest, path.basename(file)));
  const sub = file.slice(0, -6);
  if (fs.existsSync(sub)) { try { await fsp.rename(sub, path.join(dest, path.basename(sub))); } catch {} }
  delete index.files[file];
  try { await writeAtomic(INDEX_FILE, JSON.stringify(index)); } catch {}
  if (meta[id]) { delete meta[id]; await writeAtomic(META_FILE, JSON.stringify(meta, null, 1)); }
  return { ok: true, closed, note: 'Moved to ' + dest.replace(HOME, '~') };
}

// ---------- assembling the list ----------

// The context window a session is running against. A session that has ever gone past
// 200k tokens must be on a 1M window; the config can name a limit per model.
let bigModels = { at: 0, set: new Set() };
function ctxLimit(e) {
  const per = (config.contextLimits || {})[e.model];
  if (per) return per;
  if (Date.now() - bigModels.at > 10000) {
    const set = new Set();
    for (const x of Object.values(index.files)) if (x.peakCtx > 200000 && x.model) set.add(x.model);
    bigModels = { at: Date.now(), set };
  }
  if (/\[1m\]/i.test(e.model || '') || e.peakCtx > 200000 || bigModels.set.has(e.model)) return 1000000;
  return 200000;
}

function firstPending(e) {
  const list = Object.values(e.pending || {});
  return list.length ? list[list.length - 1] : null;
}

function claudeResume(e) {
  const dir = e.startCwd || e.cwd;
  return (dir ? 'cd ' + shq(dir) + ' && ' : '') + 'claude --resume ' + e.id;
}

function codexResume(r) {
  return (r.cwd ? 'cd ' + shq(r.cwd) + ' && ' : '') + 'codex resume ' + r.id;
}

async function listSessions() {
  if (Date.now() - lastScan > 4000) await scanClaude();
  const out = [];
  for (const [file, e] of Object.entries(index.files)) {
    if (!e.turns) continue;
    const m = meta[e.id] || {};
    const text = (e.customTitle + ' ' + e.aiTitle + ' ' + e.prompts.join(' '));
    out.push({
      id: e.id, src: 'claude',
      title: m.title || e.customTitle || e.aiTitle || clip(e.prompts[0], 80),
      autoTitle: e.customTitle || e.aiTitle || clip(e.prompts[0], 80),
      first: clip(e.prompts[0], 300),
      last: clip(e.prompts[e.prompts.length - 1], 300),
      cwd: e.cwd || e.startCwd, branch: e.branch,
      created: e.firstTs, updated: Math.round(e.mtimeMs), turns: e.turns,
      prompted: e.lastPromptTs || 0, answered: e.lastAssistantTs || 0, seen: m.seen || 0,
      ctx: e.ctx || 0, ctxLimit: ctxLimit(e), model: e.model || '', effort: e.effort || '',
      lastTool: e.lastTool || null, pendingTool: firstPending(e), permMode: e.permMode || '',
      prs: e.prs, mb: Math.round(e.size / 104857.6) / 10,
      tag: m.tag || autoTag(text, e.cwd), manualTag: !!m.tag,
      pinned: !!m.pinned, archived: !!m.archived, note: m.note || '',
      resume: claudeResume(e),
      hay: (text + ' ' + e.cwd + ' ' + (m.title || '') + ' ' + (m.note || '')).toLowerCase().slice(0, 30000),
    });
  }
  for (const r of loadCodex()) {
    const m = meta[r.id] || {};
    if (m.deleted) continue;
    const auto = r.name || clip(r.first, 80);
    out.push({
      id: r.id, src: 'codex',
      title: m.title || auto, autoTitle: auto,
      first: r.first, last: '',
      cwd: r.cwd, branch: r.branch,
      created: r.created, updated: r.updated, turns: 0,
      prompted: 0, answered: 0, seen: m.seen || 0,
      ctx: 0, ctxLimit: 0, model: '',
      lastTool: null, pendingTool: null,
      prs: [], mb: 0,
      tag: m.tag || autoTag(r.hay, r.cwd), manualTag: !!m.tag,
      pinned: !!m.pinned, archived: 'archived' in m ? !!m.archived : r.archived, note: m.note || '',
      resume: codexResume(r),
      hay: (r.hay + ' ' + r.cwd + ' ' + (m.title || '') + ' ' + (m.note || '')).toLowerCase(),
    });
  }
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

// ---------- transcripts ----------

function toolLabel(name, input) {
  input = input || {};
  const d = input.description || input.command || input.file_path || input.pattern || input.query || input.url || input.skill || input.prompt || '';
  return { n: name, d: clip(d, 110) };
}

function pushTool(msgs, tool) {
  const last = msgs[msgs.length - 1];
  if (last && last.r === 't') last.tools.push(tool);
  else msgs.push({ r: 't', tools: [tool] });
}

async function claudeTranscript(file, files) {
  const msgs = [];
  await scanLines(file, 0, (line) => {
    const kind = lineKind(line);
    if (kind !== 'user' && kind !== 'assistant') return;
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    if (o.isSidechain || o.type !== kind) return;
    const ts = Date.parse(o.timestamp) || 0;
    if (kind === 'user') {
      if (/^\[Request interrupted/.test(plainUserText(o))) { msgs.push({ r: 'n', t: 'Stopped', ts }); return; }
      const t = humanText(o);
      if (t) msgs.push({ r: 'u', t: t.slice(0, 8000), ts });
      return;
    }
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (!b) continue;
      if (b.type === 'text' && b.text && b.text.trim()) msgs.push({ r: 'a', t: b.text.slice(0, 12000), ts });
      else if (b.type === 'tool_use') {
        pushTool(msgs, toolLabel(b.name, b.input));
        if (files && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) && b.input && typeof (b.input.file_path || b.input.notebook_path) === 'string') {
          files.set(b.input.file_path || b.input.notebook_path, ts);
        }
      }
    }
  });
  return msgs;
}

async function codexTranscript(file) {
  const msgs = [];
  await scanLines(file, 0, (line) => {
    const head = line.latin1Slice(0, Math.min(line.length, 200));
    if (!head.includes('"type":"response_item"')) return;
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    const p = o.payload || {};
    const ts = Date.parse(o.timestamp) || 0;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      let t = '';
      for (const b of p.content || []) if (b && typeof b.text === 'string') t += (t ? '\n' : '') + b.text;
      t = t.trim();
      if (!t) return;
      if (p.role === 'user' && /^<(environment_context|user_instructions|skills_instructions|turn_aborted|permissions|system|ide_context|collaboration_mode)/.test(t)) return;
      msgs.push({ r: p.role === 'user' ? 'u' : 'a', t: t.slice(0, 12000), ts });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let args = p.arguments || p.input || '';
      if (typeof args !== 'string') { try { args = JSON.stringify(args); } catch { args = ''; } }
      pushTool(msgs, { n: p.name || 'shell', d: clip(args, 110) });
    }
  });
  return msgs;
}

// Codex records its own context use in token_count events; read the newest one from the file's end.
async function codexContext(file) {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      const len = Math.min(size, 1 << 20);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"token_count"')) continue;
        try {
          const info = JSON.parse(lines[i]).payload.info;
          if (info && info.last_token_usage) return { ctx: info.last_token_usage.input_tokens || 0, ctxLimit: info.model_context_window || 0 };
        } catch {}
      }
    } finally { await fh.close(); }
  } catch {}
  return { ctx: 0, ctxLimit: 0 };
}

function fileFor(id, src) {
  if (src === 'codex') {
    const row = loadCodex().find((r) => r.id === id);
    return row && row.rollout ? row.rollout : null;
  }
  return Object.keys(index.files).find((f) => index.files[f].id === id) || null;
}

async function fileSize(file) {
  try { return (await fsp.stat(file)).size; } catch { return 0; }
}

async function transcript(id, src, all) {
  const file = fileFor(id, src);
  if (!file) return null;
  const size = await fileSize(file);
  const files = new Map();
  let msgs = src === 'codex' ? await codexTranscript(file) : await claudeTranscript(file, files);
  const total = msgs.length;
  const LIMIT = 300;
  if (!all && total > LIMIT) msgs = msgs.slice(total - LIMIT);
  let context;
  if (src === 'codex') context = await codexContext(file);
  else { const e = index.files[file]; context = { ctx: e.ctx || 0, ctxLimit: ctxLimit(e), model: e.model || '' }; }
  const changed = [...files].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([f]) => f.replace(HOME, '~'));
  return { total, shown: msgs.length, msgs, size, files: changed, ...context };
}

// ---------- Terminal.app control ----------

const FOCUS_SCRIPT = `on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        try
          if (tty of t) is target then
            if miniaturized of w then set miniaturized of w to false
            set selected of t to true
            set frontmost of w to true
            activate
            return "ok"
          end if
        end try
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

const RESUME_SCRIPT = `on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
  return "ok"
end run`;

async function focusPid(pid) {
  const live = await getLive();
  const s = live.find((l) => l.pid === pid);
  if (!s) return { ok: false, error: 'That session is no longer running.' };
  if (!s.tty) return { ok: false, error: 'That session has no terminal attached.' };
  const r = await run('/usr/bin/osascript', ['-e', FOCUS_SCRIPT, '/dev/' + s.tty]);
  if (!r.ok) return { ok: false, error: clip(r.err, 200) };
  if (r.out.trim() !== 'ok') return { ok: false, error: 'No Terminal tab on ' + s.tty + '. It may be open in another app.' };
  return { ok: true };
}

async function resumeInTerminal(id, src) {
  let cmd = null;
  if (src === 'codex') {
    const row = loadCodex().find((r) => r.id === id);
    if (row) cmd = codexResume(row);
  } else {
    const e = Object.values(index.files).find((x) => x.id === id);
    if (e) cmd = claudeResume(e);
  }
  if (!cmd) return { ok: false, error: 'Session not found.' };
  const r = await run('/usr/bin/osascript', ['-e', RESUME_SCRIPT, cmd]);
  return r.ok ? { ok: true } : { ok: false, error: clip(r.err, 200) };
}

// ---------- uploads (images and files attached to a message) ----------

const UPLOAD_DIR = path.join(STATE_DIR, 'uploads');
const UPLOAD_NAME = /^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;
const UPLOAD_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', csv: 'text/plain', json: 'text/plain',
  ts: 'text/plain', tsx: 'text/plain', js: 'text/plain', css: 'text/plain', html: 'text/plain', log: 'text/plain',
};

function readRaw(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

async function saveUpload(req, name) {
  const ext = (String(name).toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1];
  if (!ext || !UPLOAD_TYPES[ext]) return { ok: false, error: 'That file type is not supported here. Images, PDFs and text files work.' };
  const buf = await readRaw(req, 25 << 20);
  if (!buf) return { ok: false, error: 'Files must be under 25 MB.' };
  if (!buf.length) return { ok: false, error: 'That file is empty.' };
  await fsp.mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const file = crypto.randomUUID() + '.' + (ext === 'jpeg' ? 'jpg' : ext);
  await fsp.writeFile(path.join(UPLOAD_DIR, file), buf, { mode: 0o600 });
  return { ok: true, file, path: path.join(UPLOAD_DIR, file), image: UPLOAD_TYPES[ext].startsWith('image/') };
}

function uploadPaths(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((f) => typeof f === 'string' && UPLOAD_NAME.test(f) && fs.existsSync(path.join(UPLOAD_DIR, f))).slice(0, 10).map((f) => path.join(UPLOAD_DIR, f));
}

function withAttachments(text, paths) {
  if (!paths.length) return text;
  return (text ? text + '\n\n' : '') + 'Attached files (read them):\n' + paths.join('\n');
}

// ---------- chat: send a message into a session ----------
//
// Open in a tab  -> the text is typed into that Terminal tab, only while the
//                   session is idle at its prompt. If it is working, the message
//                   waits here and is typed when the session goes idle.
// Closed session -> resumed in the background with the CLI's print mode, under
//                   the user's normal permission rules. Nothing extra is approved.

function findBin(name) {
  const dirs = [path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH || '').split(':')];
  for (const d of dirs) {
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// A child CLI must not think it is nested inside the session that started this server.
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(k)) delete env[k];
  return env;
}

function cleanText(t) {
  return String(t == null ? '' : t).replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').trim();
}


// Claude Code reads text typed into it in one go as a paste, so the newline that Terminal
// adds lands in the input box instead of sending. The text goes in as a bracketed paste, then
// the tab is brought forward for a moment and a real Return key is pressed (macOS asks for
// Accessibility permission the first time), then the previous app comes back.
const SUBMIT_SCRIPT = `on run argv
  set target to item 1 of argv
  tell application "System Events" to set prevApp to name of first application process whose frontmost is true
  set found to false
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        set hit to false
        try
          set hit to ((tty of t) is target)
        end try
        if hit then
          do script (item 2 of argv) in t
          delay 0.5
          if miniaturized of w then set miniaturized of w to false
          set selected of t to true
          set frontmost of w to true
          set index of w to 1
          activate
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
  end tell
  if not found then return "notfound"
  delay 0.35
  try
    tell application "System Events" to key code 36
  on error
    if prevApp is not "Terminal" then
      try
        tell application prevApp to activate
      end try
    end if
    return "typed-only"
  end try
  delay 0.15
  if prevApp is not "Terminal" then
    try
      tell application prevApp to activate
    end try
  end if
  return "ok"
end run`;

async function typeIntoTab(tty, text) {
  const payload = '\x1b[200~' + text.replace(/\n/g, '\r') + '\x1b[201~';
  const r = await run('/usr/bin/osascript', ['-e', SUBMIT_SCRIPT, '/dev/' + tty, payload], 15000);
  const out = r.out.trim();
  if (out === 'notfound') return { ok: false, error: 'No Terminal tab on ' + tty + '.' };
  if (out === 'typed-only' || (!r.ok && /not allowed|assistive|1002|-25211|-1719/i.test(r.err))) {
    return { ok: false, typed: true, error: 'Typed into the tab, but macOS blocked the Enter key. Allow Terminal in System Settings, Privacy & Security, Accessibility, then press Enter in the tab.' };
  }
  if (!r.ok) return { ok: false, error: clip(r.err, 200) };
  return { ok: true, mode: 'tab' };
}

const runs = new Map();   // session id -> background reply, running or just finished
const queued = new Map(); // session id -> message waiting for a working tab to go idle
const queuedBg = new Map(); // session id -> message waiting for a background chat to finish

const MODELS = { has: (m) => /^claude-[a-z]+-\d+-\d+$/.test(String(m || '')) || ['fable', 'opus', 'sonnet', 'haiku'].includes(m) };

// Newest version of each family seen in your chats, so the picker can name exact versions.
function latestModels() {
  const best = {};
  for (const e of Object.values(index.files)) {
    const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(e.model || '');
    if (!m) continue;
    const v = Number(m[2]) * 100 + Number(m[3]);
    if (!best[m[1]] || v > best[m[1]].v) best[m[1]] = { v, id: e.model };
  }
  const fallback = { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
  const out = {};
  for (const f of ['fable', 'opus', 'sonnet', 'haiku']) {
    const seen = best[f] && best[f].id;
    const fb = fallback[f];
    const num = (id) => { const x = /-(\d+)-(\d+)$/.exec(id); return x ? Number(x[1]) * 100 + Number(x[2]) : 0; };
    out[f] = seen && num(seen) >= num(fb) ? seen : fb;
  }
  return out;
}
const MODES = new Set(['auto', 'acceptEdits', 'plan', 'manual', 'dontAsk']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function startRun({ id, src, text, cwd, isNew, files = [], allowEdits = false, dirs = [], model = '', mode = 'auto', effort = '' }) {
  const bin = findBin(src === 'codex' ? 'codex' : 'claude');
  if (!bin) return { ok: false, error: (src === 'codex' ? 'codex' : 'claude') + ' command not found.' };
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); } catch { return { ok: false, error: 'The folder this session ran in no longer exists: ' + cwd }; }
  const images = files.filter((f) => /\.(png|jpg|gif|webp)$/.test(f));
  const args = src === 'codex'
    ? ['exec', 'resume', '--skip-git-repo-check', ...images.flatMap((f) => ['--image', f]), id, '-']
    : ['-p', '--output-format', 'stream-json', '--verbose', ...(isNew ? ['--session-id', id] : ['--resume', id]),
      ...(files.length ? ['--add-dir', UPLOAD_DIR] : []), ...dirs.flatMap((d) => ['--add-dir', d]),
      '--permission-mode', allowEdits && mode !== 'auto' ? 'acceptEdits' : MODES.has(mode) ? (mode === 'manual' ? 'auto' : mode) : 'auto',
      ...(MODELS.has(model) ? ['--model', model] : []), ...(EFFORTS.has(effort) ? ['--effort', effort] : [])];
  // Output goes to files and the process is detached, so restarting the Hub never cuts a reply off.
  const runDir = path.join(STATE_DIR, 'runs');
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const outFile = path.join(runDir, id + '.out');
  const errFile = path.join(runDir, id + '.err');
  const outFd = fs.openSync(outFile, 'w', 0o600);
  const errFd = fs.openSync(errFile, 'w', 0o600);
  const child = spawn(bin, args, { cwd, env: childEnv(), stdio: ['pipe', outFd, errFd], detached: true });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const job = { src, startedAt: Date.now(), endedAt: 0, child, done: false, stopped: false, error: '', tail: '', buf: '', denials: [], text, files, allowEdits };
  runs.set(id, job);
  child.stdin.on('error', () => {});
  child.stdin.end(text);
  child.on('error', (err) => { job.done = true; job.endedAt = Date.now(); job.error = err.message; });
  child.on('exit', (code) => {
    job.done = true;
    job.endedAt = Date.now();
    try { job.tail = fs.readFileSync(errFile, 'utf8').slice(-1500); } catch {}
    if (src !== 'codex') {
      try {
        const content = fs.readFileSync(outFile, 'utf8');
        setUsage(usageFromText(content, Date.now()));
        const lines = content.trim().split('\n');
        for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
          if (!lines[i].includes('"type":"result"')) continue;
          const o = JSON.parse(lines[i]);
          if (o.is_error) job.error = clip(o.result || o.subtype || 'The reply failed.', 300);
          // Tools it was not allowed to run without you; shown so you can retry or take it to Terminal.
          if (Array.isArray(o.permission_denials)) job.denials = o.permission_denials.slice(0, 6).map((d) => toolLabel(d.tool_name || 'tool', d.tool_input || {}));
          break;
        }
      } catch {}
    }
    fs.promises.unlink(outFile).catch(() => {});
    fs.promises.unlink(errFile).catch(() => {});
    if (job.stopped) job.error = '';
    else if (code && !job.error) job.error = clip(job.tail || 'Stopped with exit code ' + code, 300);
    codexCache.at = 0;
  });
  return { ok: true, mode: 'background' };
}

// ---------- plan usage (5-hour and weekly limits) ----------
// Two sources, both from Claude Code itself: the rate_limit_event lines background replies
// print in stream-json, and the status line JSON open Terminal tabs send to /api/statusline.
// Within one window usage only goes up, so a stale reading never lowers the number.

const USAGE_FILE = path.join(STATE_DIR, 'usage.json');
let usage = readJson(USAGE_FILE, null);
let usageCheckedAt = 0;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const clampPct = (x) => Math.max(0, Math.min(100, Math.round(x * 10) / 10));

function mergeWindow(a, b) {
  if (!b) return a || null;
  if (!a) return b;
  if (b.resetsAt > a.resetsAt + 60000) return b;
  if (b.resetsAt < a.resetsAt - 60000) return a;
  return b.pct >= a.pct ? b : a;
}

function setUsage(next) {
  if (!next || (!next.five && !next.week)) return;
  const prev = usage || {};
  const merged = { five: mergeWindow(prev.five, next.five), week: mergeWindow(prev.week, next.week), at: Math.max(prev.at || 0, next.at || 0) };
  if (JSON.stringify(merged) === JSON.stringify(usage)) return;
  usage = merged;
  Promise.resolve(writeAtomic(USAGE_FILE, JSON.stringify(usage))).catch(() => {});
}

function usageFromEvent(info, at) {
  if (!info || typeof info !== 'object') return null;
  const win = (x) => (x && typeof x.utilization === 'number' ? { pct: clampPct(x.utilization * 100), resetsAt: (Number(x.resetsAt) || 0) * 1000 } : null);
  const w = info.unifiedWindows || {};
  const out = { five: win(w.five_hour), week: win(w.seven_day), at };
  if (!out.five && !out.week && typeof info.utilization === 'number') {
    if (info.rateLimitType === 'five_hour') out.five = win(info);
    else if (info.rateLimitType === 'seven_day') out.week = win(info);
  }
  return out;
}

function usageFromText(txt, at) {
  const i = String(txt || '').lastIndexOf('"type":"rate_limit_event"');
  if (i < 0) return null;
  const start = txt.lastIndexOf('\n', i) + 1;
  const end = txt.indexOf('\n', i);
  try { return usageFromEvent(JSON.parse(txt.slice(start, end < 0 ? undefined : end)).rate_limit_info, at); } catch { return null; }
}

function usageFromStatus(b) {
  const r = b && b.rate_limits;
  if (!r || typeof r !== 'object') return null;
  const win = (x) => (x && typeof x.used_percentage === 'number' ? { pct: clampPct(x.used_percentage), resetsAt: (Number(x.resets_at) || 0) * 1000 } : null);
  return { five: win(r.five_hour), week: win(r.seven_day), at: Date.now() };
}

// How far each reply's output has been read, so every refresh reads only what is new.
const usageOffsets = new Map();
async function scanRunUsage(file, st) {
  let from = usageOffsets.get(file) || 0;
  if (st.size < from) from = 0;
  if (st.size - from > 64 << 20) from = st.size - (64 << 20);
  if (st.size <= from) return;
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - from);
    await fh.read(buf, 0, buf.length, from);
    const nl = buf.lastIndexOf(10);
    if (nl < 0) return;
    usageOffsets.set(file, from + nl + 1);
    setUsage(usageFromText(buf.toString('utf8', 0, nl + 1), Math.round(st.mtimeMs)));
  } finally { await fh.close(); }
}

// Replies still running (or started before a Hub restart) keep their output in runs/*.out.
async function refreshUsage() {
  if (Date.now() - usageCheckedAt < 8000) return;
  usageCheckedAt = Date.now();
  const dir = path.join(STATE_DIR, 'runs');
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return; }
  for (const n of names) {
    if (!n.endsWith('.out')) continue;
    const f = path.join(dir, n);
    let st;
    try { st = await fsp.stat(f); } catch { continue; }
    if (usageOffsets.get(f) === st.size) continue;
    try { await scanRunUsage(f, st); } catch {}
  }
}

// After typing /model or /effort into a tab, Claude Code logs its answer as a
// <local-command-stdout> line. Returns true as soon as that shows up.
async function waitForCommandAck(file, from, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleepMs(100);
    let size = 0;
    try { size = (await fsp.stat(file)).size; } catch { continue; }
    if (size <= from) continue;
    try {
      const fh = await fsp.open(file, 'r');
      try {
        const len = Math.min(size - from, 256 * 1024);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        if (buf.toString('utf8').includes('<local-command-stdout>')) return true;
      } finally { await fh.close(); }
    } catch {}
  }
  return false;
}

async function sendMessage(id, src, raw, fileList, allowEdits, model, effort, planMode) {
  const files = uploadPaths(fileList);
  const text = withAttachments(cleanText(raw), files);
  if (!text) return { ok: false, error: 'Nothing to send.' };
  if (text.length > 20000) return { ok: false, error: 'That message is too long to send from here.' };
  if (src !== 'codex') {
    const live = (await getLive()).find((l) => l.id === id);
    if (live && live.bg) {
      if (live.status === 'busy' || !(runs.get(id) || { done: true }).done) {
        const prev = queuedBg.get(id);
        queuedBg.set(id, { text: prev ? prev.text + '\n\n' + text : text, files: [...(prev ? prev.files : []), ...files], model: model || (prev && prev.model), effort: effort || (prev && prev.effort), planMode: planMode || (prev && prev.planMode), allowEdits, at: prev ? prev.at : Date.now() });
        return { ok: true, mode: 'queued' };
      }
    } else if (live) {
      if (!live.tty) return { ok: false, error: 'That session has no terminal attached.' };
      if (live.status === 'idle') {
        // Switching model in an open tab is the same as typing /model there first.
        const tfile = Object.keys(index.files).find((f) => index.files[f].id === id);
        for (const cmd of [MODELS.has(model) && '/model ' + model, EFFORTS.has(effort) && '/effort ' + effort].filter(Boolean)) {
          let from = 0;
          try { from = fs.statSync(tfile).size; } catch {}
          const m = await typeIntoTab(live.tty, cmd);
          if (!m.ok) return m;
          if (!tfile || !(await waitForCommandAck(tfile, from, 3000))) await sleepMs(tfile ? 0 : 1800);
          await sleepMs(150);
        }
        return typeIntoTab(live.tty, text);
      }
      if (live.status === 'busy') { const prev = queued.get(id); queued.set(id, { text: prev ? prev.text + '\n\n' + text : text, at: prev ? prev.at : Date.now() }); return { ok: true, mode: 'queued' }; }
      return { ok: false, error: 'That tab is in shell mode, so typing there would run a command. Use Go to tab.' };
    }
  }
  const job = runs.get(id);
  if (job && !job.done) return { ok: false, error: 'Still replying to your last message.' };
  let cwd;
  if (src === 'codex') {
    const row = loadCodex().find((r) => r.id === id);
    if (!row) return { ok: false, error: 'Session not found.' };
    cwd = row.cwd || HOME;
  } else {
    const e = Object.values(index.files).find((x) => x.id === id);
    if (!e) return { ok: false, error: 'Session not found.' };
    cwd = e.startCwd || e.cwd || HOME;
    var mode = e.permMode || 'auto';
  }
  const keepModel = src === 'codex' ? '' : model || (Object.values(index.files).find((x) => x.id === id) || {}).model || '';
  return startRun({ id, src: src === 'codex' ? 'codex' : 'claude', text, cwd, isNew: false, files, allowEdits: !!allowEdits, model: keepModel, effort: src === 'codex' ? '' : effort, mode: planMode ? 'plan' : mode });
}

function newSession(raw, folder, fileList, model, effort, planMode) {
  const files = uploadPaths(fileList);
  const text = withAttachments(cleanText(raw), files);
  if (!text) return { ok: false, error: 'Nothing to send.' };
  let cwd;
  const want = !folder || folder === '~' ? HOME : folder.startsWith('~/') ? path.join(HOME, folder.slice(2)) : folder;
  try { cwd = fs.realpathSync(want); } catch { return { ok: false, error: 'That folder does not exist.' }; }
  if (cwd !== HOME && !cwd.startsWith(HOME + path.sep)) return { ok: false, error: 'Pick a folder inside your home folder.' };
  const id = crypto.randomUUID();
  const r = startRun({ id, src: 'claude', text, cwd, isNew: true, files, model, effort, mode: planMode ? 'plan' : 'auto' });
  return r.ok ? { ok: true, id } : r;
}

// Claude Code stops a reply on Esc. This brings the session's tab to the front, presses Esc
// there (macOS needs Accessibility permission for that), then puts the previous app back.
const ESC_SCRIPT = `on run argv
  set target to item 1 of argv
  tell application "System Events" to set prevApp to name of first application process whose frontmost is true
  set found to false
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        set hit to false
        try
          set hit to ((tty of t) is target)
        end try
        if hit then
          if miniaturized of w then set miniaturized of w to false
          set selected of t to true
          set frontmost of w to true
          set index of w to 1
          activate
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
  end tell
  if not found then return "notfound"
  delay 0.35
  tell application "System Events" to key code 53
  delay 0.15
  if prevApp is not "Terminal" then
    try
      tell application prevApp to activate
    end try
  end if
  return "ok"
end run`;

async function stopSession(id) {
  const job = runs.get(id);
  if (queued.has(id) || (job && !job.done)) return cancelSend(id);
  const live = (await getLive()).find((l) => l.id === id);
  if (!live) return { ok: false, error: 'Nothing is running in that session.' };
  if (live.bg) {
    queuedBg.delete(id);
    try { process.kill(live.pid, 'SIGINT'); } catch { return { ok: false, error: 'It already finished.' }; }
    setTimeout(() => { try { process.kill(live.pid, 'SIGTERM'); } catch {} }, 4000);
    return { ok: true, mode: 'background' };
  }
  const r = await run('/usr/bin/osascript', ['-e', ESC_SCRIPT, '/dev/' + live.tty]);
  if (!r.ok) {
    if (/not allowed|assistive|1002|-25211|-1719/i.test(r.err)) return { ok: false, error: 'macOS blocked the Esc key. Allow it in System Settings, Privacy & Security, Accessibility (turn on the app that runs the sessions command, e.g. Terminal), then try again.' };
    return { ok: false, error: clip(r.err, 200) };
  }
  if (r.out.trim() !== 'ok') return { ok: false, error: 'No Terminal tab on ' + live.tty + '.' };
  return { ok: true, mode: 'tab' };
}

function cancelSend(id) {
  queued.delete(id);
  queuedBg.delete(id);
  const job = runs.get(id);
  if (job && !job.done) {
    job.stopped = true;
    job.child.kill('SIGINT');
    setTimeout(() => { if (!job.done) job.child.kill('SIGTERM'); }, 4000);
  }
  return { ok: true };
}

function failQueued(id, error) {
  runs.set(id, { done: true, endedAt: Date.now(), error, denials: [], child: null });
}

// Continue background chats once their current reply has finished.
setInterval(async () => {
  if (!queuedBg.size) return;
  let live;
  try { live = await getLive(); } catch { return; }
  for (const [id, q] of [...queuedBg]) {
    if (live.some((l) => l.id === id)) continue;
    const job = runs.get(id);
    if (job && !job.done) continue;
    queuedBg.delete(id);
    const e = Object.values(index.files).find((x) => x.id === id);
    if (!e) { failQueued(id, 'The chat was not found, so your waiting message was not sent.'); continue; }
    const r = startRun({ id, src: 'claude', text: q.text, cwd: e.startCwd || e.cwd || HOME, isNew: false, files: q.files, allowEdits: q.allowEdits, model: q.model || e.model, effort: q.effort, mode: q.planMode ? 'plan' : e.permMode || 'auto' });
    if (!r.ok) failQueued(id, 'Your waiting message was not sent: ' + r.error);
  }
}, 2000).unref();

// Deliver waiting messages once their tab is idle. Give up after 30 minutes or if the tab closes.
setInterval(async () => {
  if (!queued.size) return;
  let live;
  try { live = await getLive(); } catch { return; }
  for (const [id, q] of [...queued]) {
    const l = live.find((x) => x.id === id);
    if (!l || !l.tty) { queued.delete(id); failQueued(id, 'The tab closed before your waiting message could go in.'); continue; }
    if (Date.now() - q.at > 30 * 60000) { queued.delete(id); failQueued(id, 'The tab was busy for 30 minutes, so your waiting message was not sent.'); continue; }
    if (l.status !== 'idle') continue;
    queued.delete(id);
    const r = await typeIntoTab(l.tty, q.text);
    if (!r.ok) failQueued(id, r.error || 'Your waiting message could not be typed into the tab.');
  }
}, 2000).unref();

async function sessionState(id, src) {
  if (src !== 'codex' && Date.now() - lastScan > 2500) await scanClaude();
  const file = fileFor(id, src);
  const job = runs.get(id);
  const failed = job && job.done && job.error && Date.now() - job.endedAt < 120000;
  const denied = job && job.done && job.denials && job.denials.length && Date.now() - job.endedAt < 600000;
  const e = src !== 'codex' && file ? index.files[file] : null;
  const bgLive = src !== 'codex' ? (await getLive()).find((l) => l.id === id && l.bg) : null;
  return {
    bgRunning: !!(bgLive && bgLive.status === 'busy'),
    exists: !!file,
    ctx: e ? e.ctx || 0 : undefined,
    ctxLimit: e ? ctxLimit(e) : undefined,
    size: file ? await fileSize(file) : 0,
    running: !!(job && !job.done) || !!(bgLive && bgLive.status === 'busy'),
    queued: queued.has(id) || queuedBg.has(id),
    error: failed ? job.error : '',
    errorAt: failed ? job.endedAt : 0,
    denials: denied ? job.denials : [],
    deniedAt: denied ? job.endedAt : 0,
    lastText: denied ? job.text : '',
    lastFiles: denied ? (job.files || []).map((f) => path.basename(f)) : [],
    lastTool: e ? e.lastTool || null : null,
    pendingTool: e ? firstPending(e) : null,
    mtime: e ? Math.round(e.mtimeMs) : 0,
    catchUp: e ? catchUp(e) : null,
  };
}

// ---------- hub: reminders and follow-ups found in chats ----------

const HUB_FILE = path.join(STATE_DIR, 'hub.json');
const DAY = 86400000;
let hub = { reminders: [], dismissed: [], seenAll: 0, learn: {} };

function loadHub() {
  try {
    const h = JSON.parse(fs.readFileSync(HUB_FILE, 'utf8'));
    if (h && Array.isArray(h.reminders)) hub = { reminders: h.reminders, dismissed: (h.dismissed || []).filter((x) => x && typeof x === 'object'), seenAll: h.seenAll || 0, learn: h.learn || {} };
  } catch {}
}
const saveHub = () => writeAtomic(HUB_FILE, JSON.stringify(hub, null, 1));

function addMonth(ms, dom) {
  const d = new Date(ms);
  const day = dom || d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + 1, 1, d.getHours(), d.getMinutes());
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, last));
  return t.getTime();
}
function nextDue(due, repeat, dom) {
  let t = due;
  const now = Date.now();
  do {
    if (repeat === 'daily') { const d = new Date(t); d.setDate(d.getDate() + 1); t = d.getTime(); }
    else if (repeat === 'weekly') { const d = new Date(t); d.setDate(d.getDate() + 7); t = d.getTime(); }
    else t = addMonth(t, dom);
  } while (t <= now);
  return t;
}

async function hubAction(b) {
  const r = hub.reminders.find((x) => x.id === b.id);
  switch (b.action) {
    case 'add': {
      const text = clip(b.text, 300);
      const due = Number(b.due);
      if (!text || !Number.isFinite(due) || due <= 0) return { ok: false, error: 'A reminder needs some text and a date.' };
      const sessionId = UUID.test(b.sessionId || '') ? b.sessionId : '';
      hub.reminders.push({
        id: crypto.randomUUID(), text, due,
        repeat: ['daily', 'weekly', 'monthly'].includes(b.repeat) ? b.repeat : '',
        sessionId, src: sessionId ? (b.src === 'codex' ? 'codex' : 'claude') : '',
        sugId: typeof b.sugId === 'string' ? b.sugId.slice(0, 40) : '',
        done: false, doneAt: 0, createdAt: Date.now(), notifiedAt: 0, dom: new Date(due).getDate(),
      });
      if (b.sugId && typeof b.sugText === 'string') learnFrom(b.sugText, +1);
      break;
    }
    case 'edit': {
      if (!r) return { ok: false, error: 'Reminder not found.' };
      const text = clip(b.text, 300);
      const due = Number(b.due);
      if (!text || !Number.isFinite(due) || due <= 0) return { ok: false, error: 'A reminder needs some text and a date.' };
      r.text = text; r.due = due; r.notifiedAt = 0; r.dom = new Date(due).getDate();
      r.repeat = ['daily', 'weekly', 'monthly'].includes(b.repeat) ? b.repeat : '';
      break;
    }
    case 'undismiss':
      hub.dismissed = hub.dismissed.filter((x) => x.id !== b.sugId);
      if (typeof b.sugText === 'string') learnFrom(b.sugText, +1.5);
      break;
    case 'done':
      if (!r) return { ok: false, error: 'Reminder not found.' };
      if (r.repeat) { r.due = nextDue(r.due, r.repeat, r.dom || new Date(r.createdDue || r.due).getDate()); r.notifiedAt = 0; }
      else { r.done = true; r.doneAt = Date.now(); }
      break;
    case 'undo':
      if (!r) return { ok: false, error: 'Reminder not found.' };
      r.done = false; r.doneAt = 0;
      break;
    case 'snooze': {
      const until = Number(b.until);
      if (!r || !Number.isFinite(until)) return { ok: false, error: 'Reminder not found.' };
      r.due = until; r.notifiedAt = 0; r.done = false;
      break;
    }
    case 'delete':
      hub.reminders = hub.reminders.filter((x) => x.id !== b.id);
      break;
    case 'dismiss':
      if (typeof b.sugId === 'string' && b.sugId) {
        const text = clip(b.sugText || '', 300);
        hub.dismissed = [...hub.dismissed.filter((x) => x.id !== b.sugId).slice(-400), { id: b.sugId.slice(0, 40), text, ts: Date.now(), due: Number(b.sugDue) || 0 }];
        if (text) learnFrom(text, -1.5);
      }
      break;
    case 'seenAll':
      hub.seenAll = Date.now();
      break;
    default:
      return { ok: false, error: 'Unknown action.' };
  }
  await saveHub();
  return { ok: true };
}

// A chat's last replies often name a future date ("first run is Nov 30"). Those
// sentences are offered as suggestions; nothing becomes a reminder until it is kept.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_RE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/g;

function at9(d) { d.setHours(9, 0, 0, 0); return d.getTime(); }

function datesIn(sentence, baseTs) {
  const found = [];
  MONTH_RE.lastIndex = 0;
  let m;
  while ((m = MONTH_RE.exec(sentence))) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const day = Number(m[2]);
    if (mon < 0 || day < 1 || day > 31) continue;
    const year = m[3] ? Number(m[3]) : new Date(baseTs).getFullYear();
    let d = new Date(year, mon, day);
    if (!m[3] && d.getTime() < baseTs - 180 * DAY) d = new Date(year + 1, mon, day);
    found.push(at9(d));
  }
  if (/\btomorrow\b/i.test(sentence)) found.push(at9(new Date(baseTs + DAY)));
  if (/\bnext week\b/i.test(sentence)) found.push(at9(new Date(baseTs + 7 * DAY)));
  const rel = sentence.match(/\bin (\d{1,2}) (day|week)s?\b/i);
  if (rel) found.push(at9(new Date(baseTs + Number(rel[1]) * (rel[2].toLowerCase() === 'week' ? 7 : 1) * DAY)));
  const wd = sentence.match(/\b(?:on|by|next|this|until|before)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
  if (wd) {
    const add = (WEEKDAYS.indexOf(wd[1].toLowerCase()) - new Date(baseTs).getDay() + 7) % 7 || 7;
    found.push(at9(new Date(baseTs + add * DAY)));
  }
  return found;
}

function cleanSentence(raw) {
  return raw.replace(/[`*_#>]/g, '').replace(/\s*\|\s*/g, ' · ').replace(/^(?:[-•·\s]+|\d+[.)]\s+)+/, '').replace(/[\s·:]+$/, '').replace(/\s+/g, ' ').trim();
}

// ---- learning what you keep and what you delete ----
const STOP = new Set('the a an and or of to in on at for by is it its this that be was are with as from will you your we our i me my so but not no yes if then than about into out up all any can do did done has have had just more most only own same some such too very one two both each few other'.split(' '));
const tokens = (t) => [...new Set(String(t).toLowerCase().replace(/[^a-z0-9$ ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)))];
function learnFrom(text, delta) {
  for (const w of tokens(text)) hub.learn[w] = Math.max(-6, Math.min(6, (hub.learn[w] || 0) + delta));
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}
const ACTION = /\b(check|review|renew|cancel|due|deadline|runs? out|expires?|follow[- ]?up|remind|send|ship|push|merge|launch|publish|refresh|re-?run|pay|invoice|call|email|reply|decide|sign[- ]?off|submit|book|report|update|audit|first (real )?run|starts?|ends?|until|before|by)\b/i;
const DESCRIPTIVE = /\b(dated|captured|was|were|had|published on|shows?|showed|labels?|unchanged|already|yesterday|last week)\b/i;
const RECUR = /\b(every\s+(day|morning|night|week|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|month)|weekly|daily|monthly|each\s+(week|month|monday|morning))\b/i;

function recurOf(sentence, baseTs) {
  const m = sentence.match(RECUR);
  if (!m) return null;
  // A schedule only counts when something actually runs or needs doing on it.
  if (!/\b(check|checks|run|runs|job|refresh|refreshes|report|post|posts|send|sends|review|remind|backup|sync|update|audit)\b/i.test(sentence)) return null;
  const w = m[0].toLowerCase();
  const weekdayNamed = /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/.test(w);
  const repeat = /month/.test(w) ? 'monthly' : !weekdayNamed && /((every|each)\s+(day|morning|night|weekday)|daily)/.test(w) ? 'daily' : 'weekly';
  const t = sentence.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || sentence.match(/\bat\s+(\d{1,2}):(\d{2})\b/);
  let hour = 9, min = 0;
  if (t) { hour = Number(t[1]) % (t[3] ? 12 : 24) + (t[3] && t[3].toLowerCase() === 'pm' ? 12 : 0); min = Number(t[2] || 0); }
  const d = new Date(Math.max(baseTs, Date.now()));
  const wd = sentence.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i);
  d.setHours(hour, min, 0, 0);
  if (wd) { const target = WEEKDAYS.indexOf(wd[1].toLowerCase()); d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7)); }
  let at = d.getTime();
  while (at <= Date.now()) at = repeat === 'monthly' ? addMonth(at) : (() => { const x = new Date(at); x.setDate(x.getDate() + (repeat === 'daily' ? 1 : 7)); return x.getTime(); })();
  return { due: at, repeat };
}

function scoreOf(sent) {
  let sc = 0;
  if (ACTION.test(sent)) sc += 1.5;
  if (DESCRIPTIVE.test(sent)) sc -= 1.5;
  if (/^[-*]?\s*\*\*/.test(sent) || sent.length > 220) sc -= 0.5;
  const toks = tokens(sent);
  if (toks.length) sc += toks.reduce((a, w) => a + (hub.learn[w] || 0), 0) / Math.sqrt(toks.length);
  return sc;
}

function suggestions() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const kept = new Set(hub.reminders.map((r) => r.sugId).filter(Boolean));
  const dismissedIds = new Set(hub.dismissed.map((x) => x.id));
  const dismissedToks = hub.dismissed.map((x) => ({ t: tokens(x.text), day: x.due ? new Date(x.due).toDateString() : '' })).filter((x) => x.t.length);
  const out = [], hidden = [];
  for (const e of Object.values(index.files)) {
    if (!e.turns || !e.tail || !e.tail.length || Date.now() - e.mtimeMs > 30 * DAY) continue;
    const m = meta[e.id] || {};
    if (m.archived) continue;
    const used = new Set();
    let n = 0;
    for (const part of [...e.tail].reverse()) {
      for (const raw of part.t.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(])/)) {
        if (n >= 2) break;
        const sent = cleanSentence(raw);
        if (sent.length < 14) continue;
        const base = part.ts || e.mtimeMs;
        const rec = recurOf(sent, base);
        let due, repeat = '';
        if (rec) { due = rec.due; repeat = rec.repeat; }
        else {
          const dates = datesIn(sent, base).filter((d) => d >= today.getTime() && d < Date.now() + 120 * DAY);
          if (!dates.length) continue;
          due = Math.min(...dates);
        }
        if (used.has(due)) continue;
        const id = crypto.createHash('sha1').update(e.id + '|' + (rec ? 'every-' + repeat : due) + '|' + sent.slice(0, 60)).digest('hex').slice(0, 16);
        if (kept.has(id) || dismissedIds.has(id)) continue;
        used.add(due);
        const score = scoreOf(sent) + (rec ? 0.5 : 0);
        const mine = tokens(sent);
        const day = new Date(due).toDateString();
        // Alike = mostly the same words, or the same day plus two shared words ("runs out", "budget").
        const sim = dismissedToks.reduce((a, x) => {
          const j = jaccard(mine, x.t);
          const shared = mine.filter((w) => x.t.includes(w)).length;
          return Math.max(a, j, x.day === day && shared >= 2 ? 0.5 : 0);
        }, 0);
        const item = { id, text: clip(sent, 200), due, repeat, sessionId: e.id, src: 'claude', title: m.title || e.customTitle || e.aiTitle || clip(e.prompts[0], 80), score: Math.round(score * 10) / 10 };
        if (sim >= 0.45) { hidden.push({ ...item, why: 'Looks like one you deleted' }); continue; }
        if (score < 0) { hidden.push({ ...item, why: 'Reads like a fact, not a to-do' }); continue; }
        n++;
        out.push(item);
      }
    }
  }
  out.sort((a, b) => b.score - a.score || a.due - b.due);
  return { list: out.slice(0, 20), hidden: hidden.slice(0, 40) };
}


// A Mac notification the first time each reminder comes due.
setInterval(async () => {
  const now = Date.now();
  let changed = false;
  for (const r of hub.reminders) {
    if (r.done || r.due > now || (r.notifiedAt && r.notifiedAt >= r.due)) continue;
    r.notifiedAt = now;
    changed = true;
    await notifyMac('Reminder', r.text);
  }
  if (changed) saveHub().catch(() => {});
}, 30000).unref();

// ---------- skills ----------
//
// Reads every place a skill can live. Changes it can make, all reversible:
//   archive / restore   moves a skill folder to ~/.claude/skills-archive/<date>/ and back
//   synced on / off     sets skillOverrides in ~/.claude/settings.json (backup kept)
// Adding a skill is never done here: it opens Claude in Terminal, which checks the skill first.

const CLAUDE_DIR = path.join(HOME, '.claude');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const ARCHIVE_DIR = path.join(CLAUDE_DIR, 'skills-archive');
const AUDITS_DIR = path.join(CLAUDE_DIR, 'skill-audits');
const TRIGGERS_FILE = path.join(CLAUDE_DIR, 'skill-triggers.json');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const LOCK_FILE = path.join(HOME, '.agents', '.skill-lock.json');
const ROUTER = path.join(CLAUDE_DIR, 'hooks', 'skill-router.py');
const SKILL_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,79}$/;

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

function frontmatter(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const out = { name: '', description: '', lines: text.split('\n').length };
  if (fm) {
    const name = fm[1].match(/^name:\s*(.+)$/m);
    const desc = fm[1].match(/^description:\s*([\s\S]*?)(?=\n[A-Za-z_-]+:|\s*$)/m);
    if (name) out.name = name[1].trim().replace(/^["']|["']$/g, '');
    if (desc) out.description = desc[1].replace(/^[>|]-?\s*/, '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function skillDirs(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const full = path.join(dir, n);
    if (fs.existsSync(path.join(full, 'SKILL.md'))) out.push({ dir: n, full });
  }
  return out;
}

function auditOf(name) {
  try {
    const t = fs.readFileSync(path.join(AUDITS_DIR, name + '.md'), 'utf8');
    const v = t.match(/^Verdict:\s*(.+)$/m);
    const d = t.match(/audit,\s*(\d{4}-\d{2}-\d{2})/);
    return { verdict: v ? v[1].trim() : 'unknown', date: d ? d[1] : '' };
  } catch { return null; }
}

function skillUsage() {
  const use = {};
  for (const e of Object.values(index.files)) {
    for (const [k, [n, ts]] of Object.entries(e.skills || {})) {
      const u = use[k] || (use[k] = { count: 0, last: 0 });
      u.count += n;
      if (ts > u.last) u.last = ts;
    }
  }
  return use;
}

function listSkills() {
  const triggers = (readJson(TRIGGERS_FILE, {}).skills) || {};
  const settings = readJson(SETTINGS_FILE, {});
  const overrides = settings.skillOverrides || {};
  const use = skillUsage();
  const usage = (...keys) => keys.reduce((a, k) => { const u = use[k]; return u ? { count: a.count + u.count, last: Math.max(a.last, u.last) } : a; }, { count: 0, last: 0 });
  const out = [];
  const add = (where, d, extra) => {
    const fm = frontmatter(path.join(d.full, 'SKILL.md'));
    if (!fm) return;
    const name = fm.name || d.dir;
    out.push({
      key: where + ':' + d.dir, dir: d.dir, name, where,
      description: clip(fm.description, 700), lines: fm.lines,
      audit: auditOf(d.dir) || auditOf(name),
      triggers: (triggers[name] || triggers[d.dir] || {}).patterns || [],
      ...extra,
    });
  };

  for (const d of skillDirs(SKILLS_DIR)) {
    if (d.dir === 'synced') continue;
    let linked = false;
    try { linked = fs.lstatSync(d.full).isSymbolicLink(); } catch {}
    add('user', d, { linked, ...usage(d.dir), on: true });
  }
  let accounts = [];
  try { accounts = fs.readdirSync(path.join(SKILLS_DIR, 'synced')); } catch {}
  for (const acct of accounts) {
    for (const d of skillDirs(path.join(SKILLS_DIR, 'synced', acct))) {
      const id = 'anthropic-skills:' + d.dir;
      add('synced', d, { ...usage(id), on: overrides[id] !== 'off' });
    }
  }
  const plugins = settings.enabledPlugins || {};
  for (const [pid, enabled] of Object.entries(plugins)) {
    const [plugin, market] = pid.split('@');
    if (!plugin || !market) continue;
    const base = path.join(CLAUDE_DIR, 'plugins', 'cache', market, plugin);
    let versions = [];
    try { versions = fs.readdirSync(base).filter((v) => !v.startsWith('.')).sort((a, b) => fs.statSync(path.join(base, a)).mtimeMs - fs.statSync(path.join(base, b)).mtimeMs); } catch { continue; }
    const v = versions[versions.length - 1];
    if (!v) continue;
    for (const d of skillDirs(path.join(base, v, 'skills'))) add('plugin', d, { plugin, ...usage(plugin + ':' + d.dir), on: !!enabled });
  }
  let dates = [];
  try { dates = fs.readdirSync(ARCHIVE_DIR).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort().reverse(); } catch {}
  for (const date of dates) for (const d of skillDirs(path.join(ARCHIVE_DIR, date))) add('archived', d, { archivedOn: date, ...usage(d.dir), on: false });
  for (const d of skillDirs(path.join(HOME, '.codex', 'skills'))) add('codex', d, { count: 0, last: 0, on: true });
  return out;
}

async function skillFile(where, dir) {
  if (!SKILL_NAME.test(dir)) return null;
  const hit = listSkills().find((x) => x.where === where && x.dir === dir);
  if (!hit) return null;
  const roots = {
    user: path.join(SKILLS_DIR, dir),
    codex: path.join(HOME, '.codex', 'skills', dir),
    archived: path.join(ARCHIVE_DIR, hit.archivedOn || '', dir),
  };
  let file = roots[where] && path.join(roots[where], 'SKILL.md');
  if (where === 'synced') {
    for (const acct of fs.readdirSync(path.join(SKILLS_DIR, 'synced'))) {
      const f = path.join(SKILLS_DIR, 'synced', acct, dir, 'SKILL.md');
      if (fs.existsSync(f)) { file = f; break; }
    }
  }
  if (where === 'plugin') {
    const base = path.join(CLAUDE_DIR, 'plugins', 'cache');
    for (const m of fs.readdirSync(base)) {
      const pbase = path.join(base, m, hit.plugin);
      if (!fs.existsSync(pbase)) continue;
      const vs = fs.readdirSync(pbase).filter((x) => !x.startsWith('.')).sort((a, b) => fs.statSync(path.join(pbase, a)).mtimeMs - fs.statSync(path.join(pbase, b)).mtimeMs);
      const v = vs.pop();
      if (!v) continue;
      const f = path.join(pbase, v, 'skills', dir, 'SKILL.md');
      if (fs.existsSync(f)) { file = f; break; }
    }
  }
  try { return { text: (await fsp.readFile(file, 'utf8')).slice(0, 200000), path: file.replace(HOME, '~') }; } catch { return null; }
}

async function skillAction(b) {
  const dir = String(b.dir || '');
  if (!SKILL_NAME.test(dir) || dir === 'synced') return { ok: false, error: 'Bad skill name.' };
  if (b.action === 'archive') {
    const from = path.join(SKILLS_DIR, dir);
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) return { ok: false, error: 'Skill not found.' };
    const date = localDate();
    const toDir = path.join(ARCHIVE_DIR, date);
    const to = path.join(toDir, dir);
    if (fs.existsSync(to)) return { ok: false, error: 'An archived copy with that name already exists today.' };
    await fsp.mkdir(toDir, { recursive: true });
    await fsp.rename(from, to);
    // So `npx skills update` does not quietly bring it back. The entry is kept aside for restore.
    const lock = readJson(LOCK_FILE, null);
    if (lock && lock.skills && lock.skills[dir]) {
      await fsp.writeFile(path.join(to, '.hub-lock-entry.json'), JSON.stringify(lock.skills[dir], null, 2));
      delete lock.skills[dir];
      await writeAtomic(LOCK_FILE, JSON.stringify(lock, null, 2));
    }
    return { ok: true };
  }
  if (b.action === 'restore') {
    const date = String(b.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Bad date.' };
    const from = path.join(ARCHIVE_DIR, date, dir);
    const to = path.join(SKILLS_DIR, dir);
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) return { ok: false, error: 'Archived skill not found.' };
    if (fs.existsSync(to)) return { ok: false, error: 'A skill with that name is already installed.' };
    await fsp.rename(from, to);
    const saved = path.join(to, '.hub-lock-entry.json');
    const entry = readJson(saved, null);
    if (entry) {
      const lock = readJson(LOCK_FILE, null);
      if (lock && lock.skills) { lock.skills[dir] = entry; await writeAtomic(LOCK_FILE, JSON.stringify(lock, null, 2)); }
      await fsp.unlink(saved).catch(() => {});
    }
    return { ok: true };
  }
  if (b.action === 'synced') {
    let raw;
    try { raw = await fsp.readFile(SETTINGS_FILE, 'utf8'); } catch { return { ok: false, error: 'Could not read settings.json.' }; }
    let settings;
    try { settings = JSON.parse(raw); } catch { return { ok: false, error: 'settings.json is not valid JSON, so it was left alone.' }; }
    await fsp.writeFile(SETTINGS_FILE + '.bak-hub', raw);
    const id = 'anthropic-skills:' + dir;
    settings.skillOverrides = settings.skillOverrides || {};
    if (b.on) delete settings.skillOverrides[id]; else settings.skillOverrides[id] = 'off';
    await writeAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
    return { ok: true, note: 'Takes effect in new sessions.' };
  }
  return { ok: false, error: 'Unknown action.' };
}

function testRouter(phrase) {
  return new Promise((resolve) => {
    if (!fs.existsSync(ROUTER)) return resolve({ ok: false, error: 'No skill router hook found.' });
    const child = execFile('/usr/bin/python3', ['-I', ROUTER], { timeout: 8000 }, (err, stdout) => {
      let out = {};
      try { out = stdout.trim() ? JSON.parse(stdout) : {}; } catch {}
      const ctx = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
      const hits = [...ctx.matchAll(/^- ([^\s(]+) \(matched "([^"]*)"\)/gm)].map((m) => ({ skill: m[1], matched: m[2] }));
      resolve({ ok: true, hits });
    });
    child.stdin.end(JSON.stringify({ prompt: String(phrase).slice(0, 2000) }));
  });
}

// Names and transport only. Never commands' env, headers or URLs with keys.
function listMcp() {
  const d = readJson(path.join(HOME, '.claude.json'), {});
  const out = [];
  const add = (scope, servers) => {
    for (const [name, v] of Object.entries(servers || {})) out.push({ name, scope, type: v.type || 'stdio', command: v.command ? path.basename(String(v.command)) : '' });
  };
  add('All projects', d.mcpServers);
  add('Home folder', ((d.projects || {})[HOME] || {}).mcpServers);
  return out;
}

const OPEN_CLAUDE_SCRIPT = `on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
  return "ok"
end run`;

// Opens an interactive Claude in Terminal with a first message, so any install
// goes through the normal permission prompts, and Claude checks the skill first.
async function openClaudeWith(prompt) {
  const text = cleanText(prompt).replace(/\n+/g, ' ').slice(0, 1500);
  if (!text) return { ok: false, error: 'Nothing to ask.' };
  const r = await run('/usr/bin/osascript', ['-e', OPEN_CLAUDE_SCRIPT, 'cd ' + shq(HOME) + ' && claude ' + shq(text)]);
  return r.ok ? { ok: true } : { ok: false, error: clip(r.err, 200) };
}

// ---------- insights: how the week went, from your own chats ----------

const NUDGE = /^(go|continue|keep going|proceed|do it|go do it|yes|y|ok|okay|done|push|push main|push to main|try now|next)\W*$/i;
const LOST = /(what is happening|whats? happening|now what|im confused|i'?m confused|what changed|what did (you|u) do|^summari[sz]e( (this|it|the chat))?\W*$|explain (the )?chat|where (was|are) (i|we)|what.?s taking so long|what w ?e ?waiting)/i;

async function insights() {
  if (Date.now() - lastScan > 4000) await scanClaude();
  const now = Date.now();
  const weekAgo = now - 7 * DAY;
  const live = await getLive();
  const byId = {};
  for (const e of Object.values(index.files)) byId[e.id] = e;
  const week = Object.values(index.files).filter((e) => e.turns && e.mtimeMs > weekAgo);
  const started = week.filter((e) => e.firstTs > weekAgo).length;
  let prompts = 0, nudges = 0, lost = 0, images = 0, pastes = 0;
  const clients = {}, hours = new Array(24).fill(0);
  for (const e of week) {
    const m = meta[e.id] || {};
    const tag = m.tag || autoTag(e.customTitle + ' ' + e.aiTitle + ' ' + e.prompts.join(' '), e.cwd);
    clients[tag] = (clients[tag] || 0) + e.prompts.filter((_, i) => (e.promptTs || [])[i] > weekAgo).length;
    const recent = e.prompts.filter((_, i) => (e.promptTs || [])[i] > weekAgo);
    prompts += recent.length;
    for (const p of recent) {
      if (NUDGE.test(p.trim())) nudges++;
      if (LOST.test(p)) lost++;
      if (/\[image/.test(p)) images++;
      if (/<pasted_content/.test(p)) pastes++;
    }
    if (e.firstTs > weekAgo) hours[new Date(e.firstTs).getHours()]++;
  }
  const skills = {};
  for (const e of week) for (const [k, [n, ts]] of Object.entries(e.skills || {})) if (ts > weekAgo) skills[k] = (skills[k] || 0) + n;
  const stale = live.filter((l) => l.status !== 'busy' && now - (l.since || 0) > 2 * DAY).length;
  const full = live.filter((l) => { const e = byId[l.id]; return e && e.ctx / ctxLimit(e) >= 0.8; }).length;
  const peak = hours.indexOf(Math.max(...hours));
  const tips = [];
  if (nudges >= 5) tips.push({ k: 'nudges', t: `You sent "go", "continue" or similar ${nudges} times. The quick buttons under each chat do that in one click.` });
  if (lost >= 3) tips.push({ k: 'lost', t: `You asked what was going on ${lost} times. Open the chat here and read "Catch up" at the top first.` });
  if (stale >= 3) tips.push({ k: 'stale', t: `${stale} tabs have sat untouched for 2+ days. Close or archive the finished ones; set a reminder on the rest.` });
  if (full >= 1) tips.push({ k: 'full', t: `${full} open ${full === 1 ? 'chat is' : 'chats are'} over 80% context. Run /compact there or start fresh before the next big task.` });
  if (live.length >= 15) tips.push({ k: 'many', t: `${live.length} tabs are open at once. Most are idle; three or four active ones is easier to keep in your head.` });
  return {
    started, prompts, nudges, lost, images, pastes, open: live.length, stale, full,
    peakHour: Math.max(...hours) ? peak : -1,
    clients: Object.entries(clients).sort((a, b) => b[1] - a[1]).slice(0, 6),
    skills: Object.entries(skills).sort((a, b) => b[1] - a[1]).slice(0, 6),
    tips,
  };
}

// The newest exchange in plain words, so a chat can be picked up without scrolling.
function catchUp(e) {
  if (!e) return null;
  const lastAsk = e.prompts[e.prompts.length - 1] || '';
  const reply = e.tail && e.tail.length ? e.tail[e.tail.length - 1] : null;
  let said = '';
  if (reply && reply.ts >= (e.lastPromptTs || 0)) {
    said = reply.t.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`>|]/g, ' ').replace(/\s+/g, ' ').trim();
    const sentences = said.match(/[^.!?]+[.!?]+(\s|$)/g) || [said];
    said = clip(sentences.slice(0, 2).join(' ').trim(), 320);
  }
  const question = reply && reply.ts >= (e.lastPromptTs || 0) && /\?\s*$/.test(reply.t.trim()) ? clip((reply.t.trim().match(/[^.!?\n]*\?\s*$/) || [''])[0].trim(), 200) : '';
  return { ask: clip(lastAsk, 200), askTs: e.lastPromptTs || 0, said, saidTs: reply ? reply.ts : 0, question };
}

// ---------- handoff: carry a full chat into a fresh one ----------

const HANDOFF_DIR = path.join(STATE_DIR, 'handoffs');

async function buildHandoff(id) {
  const file = fileFor(id, 'claude');
  const e = file && index.files[file];
  if (!e) return null;
  const m = meta[id] || {};
  const title = m.title || e.customTitle || e.aiTitle || clip(e.prompts[0], 80);
  const files = new Map();
  await claudeTranscript(file, files);
  const changed = [...files].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([f]) => f.replace(HOME, '~'));
  const cut = (t, n) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n) + ' [...]' : t; };
  const recent = e.prompts.slice(-8);
  const said = (e.tail || []).slice(-2).map((x) => cut(x.t, 1400));
  const reminders = hub.reminders.filter((r) => r.sessionId === id && !r.done).map((r) => '- ' + r.text + ' (due ' + new Date(r.due).toDateString() + ')');
  const lines = [
    '# Handoff: ' + title,
    '',
    'Picked up from an earlier Claude Code session' + ((e.ctx || 0) / ctxLimit(e) >= 0.8 ? ' that was nearly out of room.' : '.'),
    '- Old session: ' + id + (e.model ? ' (' + e.model + ')' : ''),
    '- Folder: ' + (e.startCwd || e.cwd || HOME).replace(HOME, '~') + (e.branch ? ', branch ' + e.branch : ''),
    '- Old transcript: ' + file.replace(HOME, '~') + ' (read only the end of it, and only if something below is unclear)',
    '',
    '## The goal (first request)',
    cut(e.prompts[0], 1200),
    '',
    '## Recent requests, oldest first',
    ...recent.map((x) => '- ' + cut(x, 300)),
    '',
    '## Where it got to (last replies)',
    ...(said.length ? said : ['(no reply recorded)']),
  ];
  if (changed.length) lines.push('', '## Files changed', ...changed.map((f) => '- ' + f));
  if (e.prs && e.prs.length) lines.push('', '## Pull requests', ...e.prs.map((u) => '- ' + u));
  if (m.note) lines.push('', '## My note', m.note);
  if (reminders.length) lines.push('', '## Open reminders', ...reminders);
  lines.push('', '## What to do first', 'Tell me in three lines where this stands and what is next. Check the files above against the repo before trusting this note. Ask before anything big.');
  return { text: lines.join('\n'), title, cwd: e.startCwd || e.cwd || HOME, ctx: e.ctx || 0, ctxLimit: ctxLimit(e) };
}

async function doHandoff(b) {
  const base = await buildHandoff(b.id);
  if (!base) return { ok: false, error: 'Session not found.' };
  const text = cleanText(typeof b.text === 'string' && b.text.trim() ? b.text : base.text).slice(0, 60000);
  await fsp.mkdir(HANDOFF_DIR, { recursive: true, mode: 0o700 });
  const slug = base.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'chat';
  const file = path.join(HANDOFF_DIR, localDate() + '-' + slug + '-' + b.id.slice(0, 8) + '.md');
  await fsp.writeFile(file, text + '\n', { mode: 0o600 });
  await setMeta(b.id, { note: ((meta[b.id] || {}).note ? meta[b.id].note + ' · ' : '') + 'Handed off ' + new Date().toLocaleDateString() });
  const ask = 'Read the handoff note at ' + file + ' and pick up that work from there.';
  if (b.mode === 'save') return { ok: true, file: file.replace(HOME, '~') };
  if (b.mode === 'tab') {
    const r = await run('/usr/bin/osascript', ['-e', OPEN_CLAUDE_SCRIPT, 'cd ' + shq(base.cwd) + ' && claude ' + shq(ask)]);
    return r.ok ? { ok: true, file: file.replace(HOME, '~') } : { ok: false, error: clip(r.err, 200) };
  }
  if (b.mode === 'background') {
    const id = crypto.randomUUID();
    const r = startRun({ id, src: 'claude', text: ask, cwd: base.cwd, isNew: true, dirs: [HANDOFF_DIR] });
    return r.ok ? { ok: true, id, file: file.replace(HOME, '~') } : r;
  }
  return { ok: false, error: 'Unknown mode.' };
}

// ---------- local files named in chats: preview or open ----------
// Only files under your home folder, never inside hidden folders (.ssh, .claude ...),
// and only these types. Previews are sent with a sandbox policy so nothing in them can run.

const PREVIEW_TYPES = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
};
// Code opens as text: some Macs map .py to Python Launcher, which would run it.
const OPEN_AS_TEXT = new Set(['py', 'js', 'jsx', 'ts', 'tsx', 'css', 'sh', 'rb', 'pl']);
const OPEN_EXTRA = new Set(['html', 'ts', 'tsx', 'js', 'jsx', 'css', 'py', 'docx', 'xlsx', 'pptx', 'key', 'pages', 'numbers', 'psd', 'fig', 'zip']);

function safeLocal(raw) {
  let pth = String(raw || '').trim();
  if (pth.startsWith('~/')) pth = path.join(HOME, pth.slice(2));
  if (!path.isAbsolute(pth)) return null;
  let real;
  try { real = fs.realpathSync(pth); } catch { return null; }
  if (!real.startsWith(HOME + path.sep)) return null;
  if (real.slice(HOME.length + 1).split(path.sep).some((seg) => seg.startsWith('.'))) return null;
  return real;
}

async function serveFile(req, res, raw) {
  const real = safeLocal(raw);
  const ext = real && path.extname(real).slice(1).toLowerCase();
  const type = ext && PREVIEW_TYPES[ext];
  if (!real || !type) return send(res, 404, { error: 'not found' });
  let st;
  try { st = await fsp.stat(real); } catch { return send(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return send(res, 404, { error: 'not found' });
  const head = {
    'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': ext === 'pdf' ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); return res.end(); }
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(real, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'content-length': st.size });
  fs.createReadStream(real).pipe(res);
}

async function openLocal(raw, reveal) {
  const real = safeLocal(raw);
  if (!real) return { ok: false, error: 'That file is not there, or it is somewhere this page does not open.' };
  if (reveal) { const r = await run('/usr/bin/open', ['-R', real]); return r.ok ? { ok: true } : { ok: false, error: clip(r.err, 200) }; }
  const ext = path.extname(real).slice(1).toLowerCase();
  if (/\.(app|command|workflow|terminal|pkg|mpkg|tool|scpt|scptd|applescript|action|prefPane|kext|sh|zsh|bash)$/i.test(real)) {
    return { ok: false, error: 'This page does not launch apps or scripts. Use Show in Finder.' };
  }
  let isDir = false;
  try { isDir = fs.statSync(real).isDirectory(); } catch {}
  if (!isDir && !PREVIEW_TYPES[ext] && !OPEN_EXTRA.has(ext)) return { ok: false, error: 'This page does not open .' + ext + ' files. Use Show in Finder.' };
  const asText = !isDir && OPEN_AS_TEXT.has(ext);
  const r = await run('/usr/bin/open', asText ? ['-t', real] : [real]);
  return r.ok ? { ok: true } : { ok: false, error: clip(r.err, 200) };
}

function fileInfo(raw) {
  const real = safeLocal(raw);
  if (!real) return { exists: false };
  let st;
  try { st = fs.statSync(real); } catch { return { exists: false }; }
  const ext = path.extname(real).slice(1).toLowerCase();
  return { exists: true, dir: st.isDirectory(), size: st.size, ext, preview: !!PREVIEW_TYPES[ext] && !st.isDirectory(), kind: (PREVIEW_TYPES[ext] || '').split('/')[0] };
}

// ---------- events from Claude Code hooks (Notification + Stop) ----------
// Claude Code itself says when a chat needs approval, sits idle waiting, or finishes a turn.
// That replaces guessing from transcript files wherever the hook has fired.

const hookEvents = new Map(); // session id -> { type, ts, message }
const lastNotified = new Map();

function notifyMac(title, text) {
  return run('/usr/bin/osascript', ['-e', `on run argv
  display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"
end run`, clip(title, 80), clip(text, 220)]);
}

function titleOf(id) {
  const e = Object.values(index.files).find((x) => x.id === id);
  const m = meta[id] || {};
  return m.title || (e && (e.customTitle || e.aiTitle || clip(e.prompts[0], 60))) || 'A chat';
}

async function onHookEvent(b) {
  const id = String(b.session_id || '');
  if (!UUID.test(id)) return { ok: false };
  const name = b.hook_event_name;
  let type = '';
  if (name === 'Notification' && b.notification_type === 'permission_prompt') type = 'permission';
  else if (name === 'Notification' && b.notification_type === 'idle_prompt') type = 'idle';
  else if (name === 'Stop') type = 'stop';
  if (!type) return { ok: true };
  const now = Date.now();
  hookEvents.set(id, { type, ts: now, mode: String(b.permission_mode || ''), message: clip(b.message || b.last_assistant_message || '', 300) });
  const job = runs.get(id);
  if ((meta[id] || {}).archived || (job && job.child && !job.done)) return { ok: true }; // a Hub reply in progress shows in the page
  if (Date.now() - lastScan > 3000) await scanClaude().catch(() => {});
  const e = Object.values(index.files).find((x) => x.id === id);
  const prev = lastNotified.get(id) || 0;
  if (type === 'permission' && now - prev > 20000) {
    lastNotified.set(id, now);
    notifyMac('Needs approval: ' + titleOf(id), clip(b.message || 'Claude is waiting for you to approve a step.', 200));
  }
  if (type === 'stop' && e && e.lastPromptTs && now - e.lastPromptTs > 90000 && now - prev > 20000) {
    lastNotified.set(id, now);
    const said = String(b.last_assistant_message || '').replace(/[#*`>|]/g, ' ').replace(/\s+/g, ' ').trim();
    notifyMac('Finished: ' + titleOf(id), clip(said || 'Done. Open the Hub to read it.', 200));
  }
  return { ok: true };
}

// ---------- daily backup of your own data ----------
async function backupNow() {
  const day = localDate();
  const dir = path.join(STATE_DIR, 'backups', day);
  if (fs.existsSync(dir)) return;
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const f of ['hub.json', 'meta.json', 'config.json']) {
    try { await fsp.copyFile(path.join(STATE_DIR, f), path.join(dir, f)); } catch {}
  }
  const all = (await fsp.readdir(path.join(STATE_DIR, 'backups'))).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 14))) await fsp.rm(path.join(STATE_DIR, 'backups', old), { recursive: true, force: true });
}

// ---------- scheduled jobs on this Mac (read-only) ----------
// Your own launchd agents (anything that runs a program in your home folder) and crontab.
const VENDOR = /^(com\.(apple|google|adobe|openai|grammarly|snap|microsoft|dropbox|spotify|zoom)|us\.zoom|org\.mozilla)\./i;

function describeSchedule(d) {
  const cal = d.StartCalendarInterval;
  if (cal) {
    const list = Array.isArray(cal) ? cal : [cal];
    return list.map((c) => {
      const t = c.Hour != null ? new Date(2000, 0, 1, c.Hour, c.Minute || 0).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'every hour at :' + String(c.Minute || 0).padStart(2, '0');
      if (c.Weekday != null) return 'Every ' + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][c.Weekday] + ' at ' + t;
      if (c.Day != null) return 'Day ' + c.Day + ' of each month at ' + t;
      return c.Hour != null ? 'Every day at ' + t : t;
    }).join('; ');
  }
  if (d.StartInterval) { const n = d.StartInterval; return 'Every ' + (n % 3600 === 0 ? n / 3600 + ' h' : n % 60 === 0 ? n / 60 + ' min' : n + ' s'); }
  if (d.KeepAlive) return 'Always running';
  if (d.WatchPaths) return 'When files change';
  if (d.RunAtLoad) return 'At login';
  return 'On demand';
}

function nextRun(d) {
  const cal = d.StartCalendarInterval;
  if (!cal) return d.StartInterval ? Date.now() + d.StartInterval * 1000 : 0;
  const list = Array.isArray(cal) ? cal : [cal];
  let best = 0;
  for (const c of list) {
    const x = new Date();
    x.setSeconds(0, 0);
    for (let i = 0; i < 60 * 24 * 32; i++) {
      x.setTime(x.getTime() + 60000);
      if (c.Minute != null && x.getMinutes() !== c.Minute) continue;
      if (c.Hour != null && x.getHours() !== c.Hour) continue;
      if (c.Weekday != null && x.getDay() !== c.Weekday % 7) continue;
      if (c.Day != null && x.getDate() !== c.Day) continue;
      if (c.Month != null && x.getMonth() + 1 !== c.Month) continue;
      if (!best || x.getTime() < best) best = x.getTime();
      break;
    }
  }
  return best;
}

let jobsCache = { at: 0, list: [] };
async function listJobs() {
  if (Date.now() - jobsCache.at < 30000) return jobsCache.list;
  const dir = path.join(HOME, 'Library', 'LaunchAgents');
  const status = {};
  const ll = await run('/bin/launchctl', ['list']);
  for (const line of ll.out.split('\n')) { const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)$/); if (m) status[m[3]] = { pid: m[1], code: m[2] }; }
  const list = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.plist')); } catch {}
  for (const f of names) {
    const r = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(dir, f)]);
    let d;
    try { d = JSON.parse(r.out); } catch { continue; }
    const label = d.Label || f.replace(/\.plist$/, '');
    const prog = d.Program || (d.ProgramArguments || [])[0] || '';
    const args = (d.ProgramArguments || []).slice(1);
    const mine = (prog.startsWith(HOME) || args.some((x) => String(x).startsWith(HOME))) && !VENDOR.test(label);
    if (!mine) continue;
    const st = status[label];
    const logs = [d.StandardErrorPath, d.StandardOutPath].filter(Boolean);
    let lastRun = 0, errTail = '';
    for (const lp of logs) { try { lastRun = Math.max(lastRun, fs.statSync(lp).mtimeMs); } catch {} }
    const failed = st && st.code !== '0' && st.code !== '-';
    if (failed && d.StandardErrorPath) {
      try {
        const fh = await fsp.open(d.StandardErrorPath, 'r');
        const size = (await fh.stat()).size;
        const len = Math.min(size, 2000);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        await fh.close();
        errTail = buf.toString('utf8').trim().split('\n').slice(-3).join('\n');
      } catch {}
    }
    const script = args.find((x) => String(x).startsWith(HOME)) || prog;
    list.push({
      label, name: label.replace(/^(com|org|net|io|local)\.[^.]+\./, '').replace(/[-_.]/g, ' '),
      schedule: describeSchedule(d), next: nextRun(d), lastRun: Math.round(lastRun),
      loaded: !!st, running: !!(st && st.pid !== '-'), exitCode: st ? st.code : null, failed: !!failed,
      errTail: clip(errTail, 500), script: String(script).replace(HOME, '~'), log: (d.StandardErrorPath || d.StandardOutPath || '').replace(HOME, '~'),
    });
  }
  const cron = await run('/usr/bin/crontab', ['-l']);
  if (cron.ok) for (const line of cron.out.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#') || /^\s*\w+\s*=/.test(line)) continue;
    list.push({ label: 'cron', name: clip(line.split(/\s+/).slice(5).join(' '), 60), schedule: 'cron: ' + line.split(/\s+/).slice(0, 5).join(' '), next: 0, lastRun: 0, loaded: true, running: false, exitCode: null, failed: false, errTail: '', script: '', log: '' });
  }
  jobsCache = { at: Date.now(), list };
  return list;
}

// ---------- close: end Claude in a tab and close the tab ----------
// Claude is asked to quit (SIGTERM, which it handles by saving and exiting); then the shell in
// that tab gets "exit", so Terminal closes the tab. The chat itself stays in History.
const EXIT_SHELL_SCRIPT = `on run argv
  set target to item 1 of argv
  tell application "System Events" to set prevApp to name of first application process whose frontmost is true
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        set hit to false
        try
          set hit to ((tty of t) is target)
        end try
        if hit then
          if busy of t then
            do script "exit" in t
            delay 0.8
          end if
          if busy of t then return "stillbusy"
          if (count of tabs of w) is 1 then
            close w saving no
          else
            set selected of t to true
            set frontmost of w to true
            set index of w to 1
            activate
            delay 0.3
            tell application "System Events" to keystroke "w" using command down
            delay 0.2
            if prevApp is not "Terminal" then
              try
                tell application prevApp to activate
              end try
            end if
          end if
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function closeSession(id, force) {
  const live = (await getLive()).find((l) => l.id === id);
  if (!live) return { ok: false, error: 'That chat is not open anywhere.' };
  if (live.status === 'busy' && !force) return { ok: false, needsForce: true, error: 'It is working right now.' };
  queued.delete(id);
  queuedBg.delete(id);
  try { process.kill(live.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 30 && alive(live.pid); i++) await new Promise((r) => setTimeout(r, 200));
  if (alive(live.pid)) { try { process.kill(live.pid, 'SIGKILL'); } catch {} await new Promise((r) => setTimeout(r, 300)); }
  if (alive(live.pid)) return { ok: false, error: 'Claude did not quit in that tab.' };
  if (live.bg || !live.tty) return { ok: true, closed: 'background' };
  await new Promise((r) => setTimeout(r, 400));
  const r = await run('/usr/bin/osascript', ['-e', EXIT_SHELL_SCRIPT, '/dev/' + live.tty], 15000);
  return { ok: true, closed: r.out.trim() === 'ok' ? 'tab' : 'claude' };
}

// ---------- voice dictation (Claude Code's /voice, on local Whisper) ----------
//
// The page records the mic, turns it into 16 kHz mono PCM and posts it here. A
// Python worker (voice_worker.py, mlx-whisper with whisper-large-v3-turbo) turns
// it into text on this Mac, so audio never leaves it. Claude Code's own dictation
// streams to Anthropic under the claude.ai sign-in, which a web page cannot borrow.
// Hold/tap mode, auto-send and language come from ~/.claude/settings.json (voice,
// language), read-only, so the Hub behaves like the CLI. The worker starts on first
// use and quits after 10 idle minutes to give its ~1.6 GB of memory back.

const VOICE_DIR = path.join(STATE_DIR, 'voice');
const VOICE_WORKER = path.join(__dirname, 'voice_worker.py');
const VOICE_IDLE_MS = 10 * 60000;
const VOICE_LANGS = { english: 'en', czech: 'cs', danish: 'da', dutch: 'nl', french: 'fr', german: 'de', greek: 'el', hindi: 'hi', indonesian: 'id', italian: 'it', japanese: 'ja', korean: 'ko', norwegian: 'no', polish: 'pl', portuguese: 'pt', russian: 'ru', spanish: 'es', swedish: 'sv', turkish: 'tr', ukrainian: 'uk' };
const vw = { proc: null, ready: false, queue: [], running: null, out: '', err: '', idle: null, lastError: '', seq: 0 };

function uvBin() {
  for (const p of [path.join(HOME, '.local', 'bin', 'uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv']) if (fs.existsSync(p)) return p;
  return 'uv';
}

// The speech model (~1.6 GB) downloads the first time voice is used, then works offline.
function voiceModelCached() {
  const hub = process.env.HF_HUB_CACHE || path.join(process.env.HF_HOME || path.join(HOME, '.cache', 'huggingface'), 'hub');
  try { return fs.readdirSync(path.join(hub, 'models--mlx-community--whisper-large-v3-turbo', 'snapshots')).length > 0; } catch { return false; }
}

function voiceSettings() {
  const s = readJson(SETTINGS_FILE, {});
  const v = s.voice && typeof s.voice === 'object' ? s.voice : {};
  const raw = String(s.language || '').trim().toLowerCase();
  const code = raw.split(/[-_]/)[0];
  const lang = VOICE_LANGS[raw] || (Object.values(VOICE_LANGS).includes(code) ? code : 'en');
  return { mode: v.mode === 'tap' ? 'tap' : 'hold', autoSubmit: v.autoSubmit === true, lang };
}

function voiceStatus() {
  return { ...voiceSettings(), ready: vw.ready, loading: !!vw.proc && !vw.ready, error: vw.lastError };
}

// Recognition hints, like Claude Code adding the project name and git branch:
// the tag names, the chat's folder and its git branch.
function voicePrompt(sid) {
  const e = sid ? Object.values(index.files).find((x) => x.id === sid) : null;
  // Written as plain sentences: a comma list of terms made Whisper write "NexJS" in tests.
  const names = rules.map((r) => r.name).filter(Boolean);
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0] || '';
  let p = list ? `I'm working with Claude on ${list}.` : "I'm talking to Claude.";
  const dir = e ? e.startCwd || e.cwd || '' : '';
  if (dir && dir !== HOME) p += ` This chat is in the ${path.basename(dir)} folder` + (e.branch && e.branch !== 'HEAD' ? ` on the ${e.branch} branch.` : '.');
  return p;
}

function voiceTouch() {
  clearTimeout(vw.idle);
  vw.idle = setTimeout(() => {
    if (vw.running || vw.queue.length) return voiceTouch();
    voiceQuit();
  }, VOICE_IDLE_MS);
  vw.idle.unref();
}

function voiceQuit() {
  const child = vw.proc;
  if (!child) return;
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 3000).unref();
}

function voiceFinish(job, result) {
  clearTimeout(job.timer);
  fsp.unlink(job.file).catch(() => {});
  job.resolve(result);
}

function voiceStart() {
  if (vw.proc) return voiceTouch();
  vw.ready = false;
  vw.out = '';
  vw.err = '';
  try { fs.mkdirSync(VOICE_DIR, { recursive: true, mode: 0o700 }); } catch {}
  let child;
  try {
    child = spawn(uvBin(), ['run', '--quiet', '--python', '3.12', '--with', 'mlx-whisper', 'python', '-I', VOICE_WORKER], {
      cwd: VOICE_DIR,
      env: { ...childEnv(), ...(voiceModelCached() ? { HF_HUB_OFFLINE: '1' } : {}), PYTHONUNBUFFERED: '1', TOKENIZERS_PARALLELISM: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    vw.lastError = 'Could not start the speech worker: ' + err.message;
    return;
  }
  vw.proc = child;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    vw.out += d;
    let i;
    while ((i = vw.out.indexOf('\n')) >= 0) {
      const line = vw.out.slice(0, i);
      vw.out = vw.out.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.ready) { vw.ready = true; vw.lastError = ''; voicePump(); continue; }
      const job = vw.running;
      if (!job || m.id !== job.id) continue;
      vw.running = null;
      voiceFinish(job, m.error ? { ok: false, error: 'Could not turn that into text: ' + clip(m.error, 160) } : { ok: true, text: String(m.text || ''), ms: m.ms || 0 });
      voicePump();
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { vw.err = (vw.err + d).slice(-4000); });
  child.stdin.on('error', () => {});
  child.on('error', (err) => { vw.lastError = 'Could not start the speech worker (' + err.message + '). It needs uv in ~/.local/bin.'; });
  child.on('exit', (code, sig) => {
    if (vw.proc !== child) return;
    vw.proc = null;
    vw.ready = false;
    if ((code || sig) && !vw.lastError) {
      const last = vw.err.trim().split('\n').filter(Boolean).pop() || '';
      vw.lastError = /LocalEntryNotFound|offline mode|snapshot/i.test(vw.err) ? 'The Whisper model is not downloaded on this Mac.' : 'The speech worker stopped' + (last ? ': ' + clip(last, 200) : '.');
      console.error(new Date().toISOString(), 'voice worker exited', code, sig, clip(vw.err, 1500));
    }
    const jobs = [vw.running, ...vw.queue].filter(Boolean);
    vw.running = null;
    vw.queue = [];
    for (const j of jobs) voiceFinish(j, { ok: false, error: vw.lastError || 'The speech worker stopped. Try again.' });
  });
  voiceTouch();
}

function voicePump() {
  if (!vw.queue.length) return;
  if (!vw.proc) return voiceStart();
  if (!vw.ready || vw.running) return;
  const job = vw.queue.shift();
  vw.running = job;
  vw.proc.stdin.write(JSON.stringify({ id: job.id, path: job.file, lang: job.lang, prompt: job.prompt }) + '\n');
  voiceTouch();
}

async function voiceTranscribe(req, url) {
  const buf = await readRaw(req, 8 << 20);
  if (!buf) return { ok: false, error: 'That recording is too long. About 4 minutes is the most.' };
  if (buf.length < 3200) return { ok: true, text: '' };
  const rec = String(url.searchParams.get('rec') || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
  const final = url.searchParams.get('final') === '1';
  const sid = String(url.searchParams.get('sid') || '');
  if (final) {
    // The final pass makes any preview of the same recording still waiting its turn pointless.
    vw.queue = vw.queue.filter((j) => {
      if (j.rec !== rec || j.final) return true;
      voiceFinish(j, { ok: false, stale: true });
      return false;
    });
  } else if (vw.queue.some((j) => j.rec === rec)) {
    return { ok: false, stale: true };
  }
  if (vw.lastError && !vw.proc) vw.lastError = '';
  await fsp.mkdir(VOICE_DIR, { recursive: true, mode: 0o700 });
  const id = 'v' + ++vw.seq;
  const file = path.join(VOICE_DIR, `${process.pid}-${id}.pcm`);
  await fsp.writeFile(file, buf.length % 2 ? buf.subarray(0, buf.length - 1) : buf, { mode: 0o600 });
  return new Promise((resolve) => {
    const job = { id, rec, final, file, lang: voiceSettings().lang, prompt: voicePrompt(UUID.test(sid) ? sid : ''), resolve };
    job.timer = setTimeout(() => {
      const loading = !vw.ready;
      if (vw.running === job) {
        vw.running = null;
        vw.lastError = 'The speech worker got stuck, so it was restarted.';
        try { vw.proc && vw.proc.kill('SIGKILL'); } catch {}
      } else {
        vw.queue = vw.queue.filter((j) => j !== job);
      }
      voiceFinish(job, { ok: false, error: loading ? 'The speech model is still loading. Try again in a few seconds.' : 'That took too long to turn into text.' });
    }, final ? 120000 : 60000);
    vw.queue.push(job);
    voicePump();
  });
}

// Close every idle Claude chat in a Terminal window, so the chats carry on from the Hub
// instead (they stay in the list; a reply then runs in the background). Leaves alone any
// tab that is working, running a command, waiting for approval, or (minIdleMs) used just now.
async function closeAllTabs(minIdleMs = 0) {
  const byId = {};
  for (const e of Object.values(index.files)) byId[e.id] = e;
  const targets = [];
  const kept = [];
  for (const l of await getLive()) {
    if (l.bg || !l.tty) continue;
    const ev = hookEvents.get(l.id);
    const e = byId[l.id];
    const asking = ev && ev.type === 'permission' && Date.now() - ev.ts < 6 * 3600000 && (!e || e.mtimeMs <= ev.ts + 1500);
    const why = l.status === 'busy' ? 'working' : l.status !== 'idle' ? 'running a command' : asking ? 'waiting for approval' : Date.now() - (l.since || 0) < minIdleMs ? 'used in the last few minutes' : '';
    if (why) kept.push({ id: l.id, why });
    else targets.push(l);
  }
  // End every Claude at once, then close the windows one at a time: closing a tab that
  // shares a window goes through the keyboard, so two of those must never overlap.
  for (const l of targets) {
    queued.delete(l.id);
    try { process.kill(l.pid, 'SIGTERM'); } catch {}
  }
  for (let i = 0; i < 30 && targets.some((l) => alive(l.pid)); i++) await new Promise((r) => setTimeout(r, 200));
  for (const l of targets) if (alive(l.pid)) { try { process.kill(l.pid, 'SIGKILL'); } catch {} }
  await new Promise((r) => setTimeout(r, 500));
  let closed = 0;
  let windows = 0;
  for (const l of targets) {
    if (alive(l.pid)) { kept.push({ id: l.id, why: 'Claude did not quit' }); continue; }
    closed++;
    const r = await run('/usr/bin/osascript', ['-e', EXIT_SHELL_SCRIPT, '/dev/' + l.tty], 15000);
    if (r.out.trim() === 'ok') windows++;
  }
  return { ok: true, closed, windows, kept };
}

// ---------- http ----------

function allowed(req) {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
  // The page shell holds no data, so any navigation may load it. Everything under
  // /api/ must come from the page itself, never from another site.
  const site = req.headers['sec-fetch-site'];
  let isApi = true;
  try { isApi = new URL(req.url, 'http://x').pathname.startsWith('/api/'); } catch {}
  if (isApi && site && site !== 'same-origin' && site !== 'none') return false;
  if (isApi && req.headers['sec-fetch-mode'] === 'navigate' && site !== 'none') return false;
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return false;
    if (req.headers['x-sessions'] !== '1') return false;
  }
  return true;
}

// writeHead() keeps headers already set with res.setHeader() (used for the page shell).
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(data);
}

function readBody(req, limit = 65536) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
    req.on('close', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = url.pathname;

    if (req.method === 'GET') {
      if (p === '/' || p === '/index.html') {
        res.setHeader('x-frame-options', 'DENY');
        res.setHeader('content-security-policy', "frame-ancestors 'none'");
        return send(res, 200, await fsp.readFile(path.join(PUBLIC_DIR, 'index.html')), 'text/html; charset=utf-8');
      }
      if (p === '/api/ping') return send(res, 200, { ok: true });
      if (p === '/api/voice') {
        if (url.searchParams.get('warm') === '1') voiceStart();
        return send(res, 200, voiceStatus());
      }
      if (p === '/api/progress') return send(res, 200, { scanning: !!scanning, ...scanProgress });
      if (p === '/api/live') {
        if (Date.now() - lastScan > 3000) await scanClaude();
        const byId = {};
        for (const e of Object.values(index.files)) byId[e.id] = e;
        const live = (await getLive()).map((l) => {
          const e = byId[l.id];
          const ev = hookEvents.get(l.id) || null;
          return e ? { ...l, ev, ctx: e.ctx || 0, ctxLimit: ctxLimit(e), lastTool: e.lastTool || null, pendingTool: firstPending(e), mtime: Math.round(e.mtimeMs), act: Math.max(e.lastPromptTs || 0, e.lastAssistantTs || 0) } : { ...l, ev };
        });
        refreshUsage().catch(() => {});
        return send(res, 200, { live, usage });
      }
      if (p === '/api/sessions') {
        loadConfig();
        const [sessions, live] = await Promise.all([listSessions(), getLive()]);
        return send(res, 200, {
          sessions, live,
          tags: rules.map((r) => ({ name: r.name, color: r.color })),
          models: latestModels(),
          defaultModel: String(readJson(SETTINGS_FILE, {}).model || ''),
          defaultEffort: String(readJson(SETTINGS_FILE, {}).effortLevel || ''),
          usage,
          configFile: CONFIG_FILE,
        });
      }
      if (p === '/api/hub') {
        if (Date.now() - lastScan > 4000) await scanClaude();
        const sug = suggestions();
        return send(res, 200, { reminders: hub.reminders, suggestions: sug.list, hiddenSuggestions: sug.hidden, seenAll: hub.seenAll, jobs: await listJobs() });
      }
      if (p === '/api/skills') {
        if (Date.now() - lastScan > 4000) await scanClaude();
        return send(res, 200, { skills: listSkills(), mcp: listMcp(), router: fs.existsSync(ROUTER), audits: fs.existsSync(AUDITS_DIR) });
      }
      if (p.startsWith('/api/upload/')) {
        const name = p.slice('/api/upload/'.length);
        if (!UPLOAD_NAME.test(name)) return send(res, 400, { error: 'bad name' });
        const type = UPLOAD_TYPES[name.split('.').pop()];
        if (!type || !type.startsWith('image/')) return send(res, 404, { error: 'not found' });
        try { return send(res, 200, await fsp.readFile(path.join(UPLOAD_DIR, name)), type); } catch { return send(res, 404, { error: 'not found' }); }
      }
      if (p === '/api/skill') {
        const f = await skillFile(url.searchParams.get('where') || '', url.searchParams.get('dir') || '');
        return f ? send(res, 200, f) : send(res, 404, { error: 'not found' });
      }
      if (p === '/api/insights') return send(res, 200, await insights());
      if (p === '/api/file') return serveFile(req, res, url.searchParams.get('path'));
      if (p === '/api/fileinfo') return send(res, 200, fileInfo(url.searchParams.get('path')));
      if (p === '/api/handoff') {
        const id = url.searchParams.get('id') || '';
        if (!UUID.test(id)) return send(res, 400, { error: 'bad id' });
        const h = await buildHandoff(id);
        return h ? send(res, 200, h) : send(res, 404, { error: 'not found' });
      }
      if (p === '/api/state') {
        const id = url.searchParams.get('id') || '';
        if (!UUID.test(id)) return send(res, 400, { error: 'bad id' });
        return send(res, 200, await sessionState(id, url.searchParams.get('src')));
      }
      if (p === '/api/transcript') {
        const id = url.searchParams.get('id') || '';
        if (!UUID.test(id)) return send(res, 400, { error: 'bad id' });
        const t = await transcript(id, url.searchParams.get('src'), url.searchParams.get('all') === '1');
        return t ? send(res, 200, t) : send(res, 404, { error: 'not found' });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (req.method === 'POST' && p === '/api/voice') return send(res, 200, await voiceTranscribe(req, url));
    if (req.method === 'POST' && p === '/api/upload') {
      return send(res, 200, await saveUpload(req, url.searchParams.get('name') || ''));
    }
    if (req.method === 'POST') {
      const body = await readBody(req, p === '/api/event' ? 4 << 20 : 65536);
      if (!body) return send(res, 400, { error: 'bad body' });
      if (p === '/api/meta') {
        if (!UUID.test(body.id || '') || typeof body.patch !== 'object' || !body.patch) return send(res, 400, { error: 'bad request' });
        await setMeta(body.id, body.patch);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/delete') return send(res, 200, await deleteSession(body));
      if (p === '/api/focus') {
        const pid = Number(body.pid);
        if (!Number.isInteger(pid) || pid < 2) return send(res, 400, { error: 'bad pid' });
        return send(res, 200, await focusPid(pid));
      }
      if (p === '/api/hub') return send(res, 200, await hubAction(body));
      if (p === '/api/statusline') { setUsage(usageFromStatus(body)); return send(res, 200, { ok: true }); }
      if (p === '/api/event') return send(res, 200, await onHookEvent(body));
      if (p === '/api/test-notification') { const r = await notifyMac('Hub test', 'If you can read this, reminders will reach you.'); return send(res, 200, { ok: r.ok, error: r.ok ? '' : clip(r.err, 200) }); }
      if (p === '/api/skills') return send(res, 200, await skillAction(body));
      if (p === '/api/router') return send(res, 200, await testRouter(body.text || ''));
      if (p === '/api/ask') {
        const kind = body.kind;
        const target = cleanText(body.target || '').slice(0, 500);
        let prompt;
        if (kind === 'add') prompt = 'Check this skill before installing it: where it comes from, what it runs and what it can access. Tell me what you found in plain words, and install it only if it looks safe: ' + target;
        else if (kind === 'create') prompt = 'Help me write a new Claude Code skill for: ' + target;
        else if (kind === 'reaudit') prompt = 'Review my installed skill for safety and tell me in plain words what it does and what it can access: ' + target;
        else if (kind === 'auditall') prompt = 'Review each of my installed Claude Code skills for safety. For each one, tell me in plain words what it does and what it can access.';
        else return send(res, 400, { error: 'bad kind' });
        if (kind !== 'auditall' && !target) return send(res, 200, { ok: false, error: 'Say which skill.' });
        return send(res, 200, await openClaudeWith(prompt));
      }
      if (p === '/api/send') {
        if (!UUID.test(body.id || '') || typeof body.text !== 'string') return send(res, 400, { error: 'bad request' });
        return send(res, 200, await sendMessage(body.id, body.src, body.text, body.files, body.allowEdits, body.model, body.effort, !!body.plan));
      }
      if (p === '/api/new') {
        if (typeof body.text !== 'string') return send(res, 400, { error: 'bad request' });
        return send(res, 200, newSession(body.text, typeof body.cwd === 'string' ? body.cwd : '', body.files, body.model, body.effort, !!body.plan));
      }
      if (p === '/api/cancel') {
        if (!UUID.test(body.id || '')) return send(res, 400, { error: 'bad id' });
        return send(res, 200, cancelSend(body.id));
      }
      if (p === '/api/handoff') {
        if (!UUID.test(body.id || '')) return send(res, 400, { error: 'bad id' });
        return send(res, 200, await doHandoff(body));
      }
      if (p === '/api/open') return send(res, 200, await openLocal(body.path, !!body.reveal));
      if (p === '/api/closetabs') return send(res, 200, await closeAllTabs(Math.max(0, Number(body.minIdleMs) || 0)));
      if (p === '/api/close') {
        if (!UUID.test(body.id || '')) return send(res, 400, { error: 'bad id' });
        return send(res, 200, await closeSession(body.id, !!body.force));
      }
      if (p === '/api/stop') {
        if (!UUID.test(body.id || '')) return send(res, 400, { error: 'bad id' });
        return send(res, 200, await stopSession(body.id));
      }
      if (p === '/api/resume') {
        if (!UUID.test(body.id || '')) return send(res, 400, { error: 'bad id' });
        return send(res, 200, await resumeInTerminal(body.id, body.src));
      }
      return send(res, 404, { error: 'not found' });
    }
    send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'server error' });
  }
});

process.on('uncaughtException', (err) => console.error(new Date().toISOString(), 'uncaught:', err && err.stack || err));
process.on('unhandledRejection', (err) => console.error(new Date().toISOString(), 'unhandled:', err && err.stack || err));
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
// Recordings left over from a previous run of the server.
try { for (const f of fs.readdirSync(VOICE_DIR)) if (f.endsWith('.pcm')) fs.unlinkSync(path.join(VOICE_DIR, f)); } catch {}
loadConfig();
setTimeout(() => backupNow().catch(() => {}), 5000);
setInterval(() => backupNow().catch(() => {}), 3600000).unref();
loadHub();
// Unread dots only count from the first time the hub runs, not for old history.
if (!hub.seenAll) { hub.seenAll = Date.now(); saveHub().catch(() => {}); }
server.listen(PORT, HOST, () => {
  console.log(`session dashboard: http://${HOST}:${PORT}`);
  scanClaude();
});
