#!/usr/bin/env -S node --max-old-space-size=96
// glance — read-only overview of every local Claude Code session and what each one needs from you.
// No dependencies. Reads ~/.claude/sessions/*.json and the tail of each transcript. Never writes, never controls.
// Run: node glance.mjs   → http://127.0.0.1:7357   (settings: environment variables or .env, see README)

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

// ---------- local config file (before any setting is read) ----------
// Precedence: a non-empty variable already in the environment > the .env file > built-in defaults.
// GLANCE_ENV_FILE points at another file. A missing file is fine; a malformed one stops glance.
const KNOWN = new Set(['GLANCE_PORT', 'GLANCE_ENV_FILE', 'GLANCE_IGNORE_NAMES', 'GLANCE_ASK_EXTRA', 'GLANCE_MEMORY',
  'GLANCE_MEMORY_CUE', 'GLANCE_MEMORY_WAIT', 'GLANCE_MEMORY_SKIP', 'GLANCE_PROJECT_PREFIX', 'GLANCE_ALLOWED_HOSTS',
  'GLANCE_TAILSCALE_USERS', 'GLANCE_DEV']);
function loadEnv() {
  const file = process.env.GLANCE_ENV_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  const fail = (i, msg) => { console.error(`glance: ${file}${i == null ? '' : ':' + (i + 1)}: ${msg}`); process.exit(2); };
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return;
    fail(null, `cannot read: ${e.message}`);
  }
  if (typeof util.parseEnv !== 'function') fail(null, `reading it needs Node 20.12 or later (this is ${process.version})`);
  txt = txt.replace(/^﻿/, '');  // a byte-order mark would become part of the first name
  // Node's parser drops what it cannot read without a word, and it ends a quoted value at the next
  // same quote (no escapes) and an unquoted one at '#'. Check the shape first so nothing is lost quietly.
  const restOk = (s) => /^\s*(?:#.*)?$/.test(s);
  const cutAfter = (q, s) => `the value ends at the second ${q}, so "${s.trim().slice(0, 40)}" would be dropped` +
    (q === "'" ? ` (write ' inside a regular expression as \\x27)` : '');
  let open = null;
  txt.split(/\r?\n/).forEach((line, i) => {
    if (open) {
      const at = line.indexOf(open);
      if (at < 0) return;
      if (!restOk(line.slice(at + 1))) fail(i, cutAfter(open, line.slice(at + 1)));
      open = null; return;
    }
    if (/^\s*(?:#.*)?$/.test(line)) return;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) fail(i, `expected NAME=value, got: ${line.slice(0, 80)}`);
    const [, name, v] = m;
    if (name.startsWith('GLANCE_') && !KNOWN.has(name)) console.error(`glance: ${file}:${i + 1}: unknown setting ${name} (ignored)`);
    const q = v[0];
    if (q === '"' || q === "'" || q === '`') {
      const end = v.indexOf(q, 1);
      if (end < 0) open = q;
      else if (!restOk(v.slice(end + 1))) fail(i, `${name}: ${cutAfter(q, v.slice(end + 1))}`);
    } else {
      const h = v.indexOf('#');
      if (h >= 0 && (h === 0 || !/\s/.test(v[h - 1])))
        console.error(`glance: ${file}:${i + 1}: ${name}: an unquoted value ends at '#', so it is read as "${v.slice(0, h).trim()}"; put the value in quotes to keep the #`);
    }
  });
  if (open) fail(null, `a value opened with ${open} is never closed`);
  let vars;
  try { vars = util.parseEnv(txt); } catch (e) { fail(null, `cannot load: ${e.message}`); }
  // An empty variable in the environment counts as unset, so the file's value applies.
  for (const [k, v] of Object.entries(vars)) if (!process.env[k]) process.env[k] = v;
}
loadEnv();

const PORT = Number(process.env.GLANCE_PORT || 7357);
const HOST = '127.0.0.1';
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SESS_DIR = path.join(CLAUDE, 'sessions');
const PROJ_DIR = path.join(CLAUDE, 'projects');
const TAIL_BYTES = 1536 * 1024;

// ---------- configuration (environment variables; see README) ----------
function envRegex(name, fallback) {  // fallback null → no regex unless the variable is set
  const v = process.env[name];
  if (v === undefined || v === '') return fallback == null ? null : new RegExp(fallback, 'i');
  try { return new RegExp(v, 'i'); }
  catch (e) { console.error(`glance: ${name} is not a valid regular expression: ${e.message}`); process.exit(2); }
}
const list = (v) => (v || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
// Session names whose own waits ("deploy is waiting for…") are not asks to you. Comma-separated; default none.
const IGNORE_NAMES = (process.env.GLANCE_IGNORE_NAMES || '').split(',').map(x => x.trim()).filter(Boolean);
const IGNORE_RE = IGNORE_NAMES.length
  ? new RegExp(String.raw`\b(?:${IGNORE_NAMES.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\b (?:is |are )?(?:waiting|asking)`, 'i')
  : null;
// Extra sentences that count as an ask to you (OR-ed onto ASK below), e.g. how your sessions name you. Default none.
const ASK_EXTRA = envRegex('GLANCE_ASK_EXTRA', null);
// Memory sidebar (off by default): lines of each project's memory/MEMORY.md index that name something waiting on you.
const MEMORY_ON = (() => {
  const v = String(process.env.GLANCE_MEMORY || '').trim();
  if (!v || /^(?:0|off|false|no)$/i.test(v)) return false;
  if (/^(?:1|on|true|yes)$/i.test(v)) return true;
  console.error(`glance: GLANCE_MEMORY must be 1/on/true/yes or 0/off/false/no, got "${v}"`); process.exit(2);
})();
const MEM_CUE = envRegex('GLANCE_MEMORY_CUE', String.raw`(pending|waiting (?:on|for) you|needs you|blocked on you|decisions? (?:pending|untaken))`);
const MEM_WAIT = envRegex('GLANCE_MEMORY_WAIT', String.raw`((?:\d+ )?decisions? (?:pending|untaken)[^;]*|waiting (?:on|for) you[^;]*|needs you[^;]*|blocked on you[^;]*|pending[^;]*)`);
const MEM_SKIP = envRegex('GLANCE_MEMORY_SKIP', String.raw`\b(?:DONE|CLOSED|COMPLETE|PARKED)\b`);
// Memory item label: the project folder slug minus your home folder, then minus these prefixes (comma-separated).
const HOME_SLUG = os.homedir().replace(/[^A-Za-z0-9]/g, '-') + '-';
const PROJECT_PREFIXES = (process.env.GLANCE_PROJECT_PREFIX || '').split(',').map(x => x.trim()).filter(Boolean);
function projectLabel(dir) {
  let p = dir.startsWith(HOME_SLUG) ? dir.slice(HOME_SLUG.length) : dir;
  for (const pre of PROJECT_PREFIXES) if (p.startsWith(pre)) { p = p.slice(pre.length); break; }
  return p;
}
const MAX_TEXT = 4000;

// ---------- transcript parsing (cached by size+mtime) ----------
const cache = new Map(); // file -> { key, data }

function slugFor(cwd) { return cwd.replace(/[^A-Za-z0-9]/g, '-'); }

async function findTranscript(cwd, sessionId) {
  const direct = path.join(PROJ_DIR, slugFor(cwd), sessionId + '.jsonl');
  try { await fsp.access(direct); return direct; } catch {}
  try {
    for (const d of await fsp.readdir(PROJ_DIR)) {
      const p = path.join(PROJ_DIR, d, sessionId + '.jsonl');
      try { await fsp.access(p); return p; } catch {}
    }
  } catch {}
  return null;
}


const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
};
const clip = (s, n = MAX_TEXT) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
const ART_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/g;

function isHumanPrompt(r) {
  if (r.type !== 'user' || r.isMeta || (r.origin && r.origin.kind !== 'human') || r.isCompactSummary || r.isVisibleInTranscriptOnly) return false;
  const c = r.message?.content;
  if (Array.isArray(c) && c.some(x => x?.type === 'tool_result')) return false;
  const t = textOf(c).trim();
  if (!t || t.startsWith('<') || t.startsWith('Stop hook feedback') || t.startsWith('This session is being continued') || t.startsWith('[Request interrupted')) return false;
  return true;
}

function parseTranscript(raw, prev) {
  const out = prev || {
    title: null, goal: null, lastPrompt: null, lastHuman: null, lastAssistant: null,
    recap: null, pending: new Map(), lastTool: null, prs: new Map(), artifacts: new Map(),
    lastTs: null, model: null, peerMsg: null,
  };
  for (const line of raw.split('\n')) {  // reducer: safe to feed appended chunks
    if (!line) continue;
    if (line.length > 256 * 1024) {  // big blobs/tool results: only note which tool calls they answer
      for (const m of line.matchAll(/"tool_use_id":"([^"]+)"/g)) out.pending.delete(m[1]);
      continue;
    }
    let r; try { r = JSON.parse(line); } catch { continue; }
    const ts = r.timestamp || null;
    if (ts) out.lastTs = ts;
    switch (r.type) {
      case 'ai-title': out.title = r.aiTitle || out.title; break;
      case 'custom-title': out.customTitle = r.customTitle || out.customTitle; break;
      case 'last-prompt': out.lastPrompt = r.lastPrompt || out.lastPrompt; break;
      case 'pr-link': if (typeof r.prUrl === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(r.prUrl)) out.prs.set(r.prUrl, { url: r.prUrl, num: r.prNumber, repo: r.prRepository, ts }); break;
      case 'system':
        if (r.subtype === 'away_summary') out.recap = { text: String(r.content || '').replace(/\s*\(disable recaps in \/config\)\s*$/, ''), ts };
        break;
      case 'user': {
        const c = r.message?.content;
        if (Array.isArray(c)) for (const x of c) if (x?.type === 'tool_result') out.pending.delete(x.tool_use_id);
        if (r.isMeta) {
          const t = textOf(c);
          const m = t.match(/^Stop hook feedback:\n\[([\s\S]*?)\]:/);
          if (m) out.goal = { text: m[1], ts };
        } else if (isHumanPrompt(r)) {
          out.lastHuman = { text: clip(textOf(c).trim(), 1200), ts };
        } else if (r.origin && r.origin.kind && !['task-notification', 'human'].includes(r.origin.kind)) {
          out.peerMsg = { kind: r.origin.kind, ts };
        }
        break;
      }
      case 'assistant': {
        const c = r.message?.content;
        if (r.message?.model) out.model = r.message.model;
        if (!Array.isArray(c)) break;
        const t = textOf(c).trim();
        if (t) {
          out.lastAssistant = { text: clip(t), ts };
          for (const a of t.match(ART_RE) || []) out.artifacts.set(a, ts);
        }
        for (const x of c) {
          if (x?.type !== 'tool_use') continue;
          const inp = x.input || {};
          const desc = inp.description || inp.prompt?.slice?.(0, 140) || inp.command?.slice?.(0, 140) || inp.file_path || inp.url || inp.query || '';
          const tool = { id: x.id, name: x.name, desc: String(desc), ts, input: x.name === 'AskUserQuestion' ? inp : undefined };
          out.lastTool = tool;
          out.pending.set(x.id, tool);
          if (x.name === 'Artifact' && typeof inp.url === 'string' && /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+$/.test(inp.url)) out.artifacts.set(inp.url, ts);
        }
        break;
      }
    }
  }
  return out;
}

// Incremental: the first read takes the last TAIL_BYTES; later reads parse only appended bytes.
async function readRange(file, start, end) {
  const fh = await fsp.open(file, 'r');
  try { const buf = Buffer.alloc(end - start); await fh.read(buf, 0, buf.length, start); return buf; }
  finally { await fh.close(); }
}
// Lines worth keeping from outside the tail window (cheap substring filter before JSON.parse).
const STICKY = ['"type":"pr-link"', '"type":"ai-title"', '"type":"custom-title"', 'Stop hook feedback', '"kind":"human"'];
async function stickyScan(file, from, to, data) {
  if (to <= from) return data;
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: fs.createReadStream(file, { start: from, end: to - 1 }), crlfDelay: Infinity });
  let chunk = '';
  for await (const line of rl) {
    if (line.length > 256 * 1024 || !STICKY.some(k => line.includes(k))) continue;
    chunk += line + '\n';
    if (chunk.length > 1 << 20) { data = parseTranscript(chunk, data); chunk = ''; }
  }
  return parseTranscript(chunk, data);
}

async function transcriptData(file) {
  const st = await fsp.stat(file);
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.ino === st.ino) return hit.data;
  let data, buf;
  if (hit && st.size > hit.size && st.ino === hit.ino && st.size - hit.size < TAIL_BYTES) {
    buf = Buffer.concat([hit.rest, await readRange(file, hit.size, st.size)]);
    data = hit.data;
  } else {                                   // first read, truncation, rotation or a huge jump
    const start = Math.max(0, st.size - TAIL_BYTES);
    const sameFile = hit && st.ino === hit.ino && st.size > hit.size;
    // Bytes not covered by the tail: whole prefix on first read, only the skipped gap after a jump.
    data = await stickyScan(file, sameFile ? hit.size : 0, start, sameFile ? hit.data : undefined);
    if (sameFile) data.pending = new Map();
    buf = await readRange(file, start, st.size);
    if (start > 0) buf = buf.subarray(buf.indexOf(10) + 1);
  }
  // Split on bytes, not chars: a partial last line (maybe mid UTF-8 sequence) waits for the next read.
  const cut = buf.lastIndexOf(10) + 1;
  const rest = Buffer.from(buf.subarray(cut));
  data = parseTranscript(buf.subarray(0, cut).toString('utf8'), data);
  data.mtime = st.mtimeMs;
  cache.set(file, { size: st.size, ino: st.ino, rest, data });
  return data;
}

// ---------- "needs you" classification ----------
function classify(s, t) {
  const status = s.status;
  const afterHuman = (ts) => ts && (!t.lastHuman || ts >= t.lastHuman.ts);
  const pend = [...t.pending.values()];
  const ask = pend.find(p => p.name === 'AskUserQuestion');
  if (ask) {
    const qs = (ask.input?.questions || []).map(q => ({ q: q.question, opts: (q.options || []).map(o => o.label) }));
    return { kind: 'question', label: 'Asking you', since: ask.ts, questions: qs };
  }
  if (status === 'waiting' || status === 'permission' || status === 'needs_input') {
    const p = pend[pend.length - 1];
    const wf = typeof s.waitingFor === 'string' && s.waitingFor ? s.waitingFor : 'input needed';
    return { kind: 'permission', label: 'Waiting: ' + wf.slice(0, 40), since: s.statusUpdatedAt ? new Date(s.statusUpdatedAt).toISOString() : p?.ts, tool: p && /permission|tool/i.test(wf) ? { name: p.name, desc: p.desc } : undefined };
  }
  if (status === 'busy') return null;
  if (pend.length && status === 'idle') {
    const p = pend[pend.length - 1];
    const age = Date.now() - Date.parse(p.ts || 0);
    if (age > 8000 && !/^(Agent|Task|Workflow)$/.test(p.name)) return { kind: 'permission', label: 'Tool call waiting', since: p.ts, tool: { name: p.name, desc: p.desc } };
  }
  if (status !== 'idle' && status !== 'shell') return null;
  const recapFresh = t.recap && afterHuman(t.recap.ts) ? t.recap : null;
  const la = t.lastAssistant && afterHuman(t.lastAssistant.ts) ? t.lastAssistant : null;
  // The harness recap's "Next:" part is the best signal; then the tail of the last message.
  let asks = [];
  if (recapFresh) {
    const next = recapFresh.text.split(/\b(?=Next(?: step)?:|Your next step)/i).slice(1).join(' ');
    asks = asksIn(next || recapFresh.text);
    // Recaps are addressed to you: "Next: read X and answer Y" is an ask even without "you".
    const imp = next.replace(/^(?:Next(?: step)?|Your next step)[:,]?\s*/i, '');
    if (!asks.length && /^(?:please\s+)?(?:read|answer|approve|decide|review|choose|pick|confirm|listen|look|check|reply|sign|save|open|type|say|merge|test|try|give|send|accept|reject)\b/i.test(imp))
      asks.push(imp.replace(/\s+/g, ' ').slice(0, 320));
  }
  if (la) for (const a of asksIn(la.text.slice(-1800))) if (!asks.some(b => similar(a, b))) asks.push(a);
  if (!asks.length) return null;
  return { kind: 'decision', label: 'Waiting on you', since: [la?.ts, recapFresh?.ts].filter(Boolean).sort()[0], asks: asks.slice(0, 3) };
}

// Sentences that put the next move on you. Deliberately narrow: "the reviewer confirmed" or
// "waiting for daytime traffic" must not count. GLANCE_ASK_EXTRA adds your own phrases.
const ASK = new RegExp([
  String.raw`\b(?:waiting|waits|wait) (?:on|for) (?:you|your)`,
  String.raw`\bstill waiting on you`,
  String.raw`\byour next step`,
  String.raw`\bplease (?:review|decide|choose|pick|answer|reply|confirm|approve|listen|look|check|say|read|sign|type|run|open|save)`,
  String.raw`\b(?:when|once|after|until) you(?:['’]ve| have)? (?:decide|decided|answer|answered|save|saved|say|said|choose|chose|pick|picked|approve|approved|reply|replied|review|reviewed|confirm|confirmed|listen|give|send)`,
  String.raw`\byour (?:\d+ )?(?:answers?|decisions?|call|go|ok|approval|review|reply|choice|sign[- ]?off)\b`,
  String.raw`\bfor your (?:decision|answer|review|approval|ok|go)`,
  String.raw`\bneeds? (?:you|your)\b`,
  String.raw`\b(?:choose|pick) \(?[a-d1-9]\)?(?:,| or)`,
  String.raw`\bsay (?:yes|go|if you want|which)`,
  String.raw`\bnothing (?:gets|is) (?:posted|sent|merged|shipped|deployed) until you`,
  String.raw`\bgoes to you\b`,
].join('|'), 'i');

function similar(a, b) {
  const w = (x) => new Set(x.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const A = w(a), B = w(b); let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / Math.min(A.size || 1, B.size || 1) > 0.6;
}

function asksIn(text) {
  if (!text) return [];
  const parts = text.replace(/\r/g, '').split(/\n+|(?<=[.!?])\s+(?=[A-Z*(])/);
  const out = [];
  for (let p of parts) {
    p = p.replace(/^[\s>*#-]+|\*\*/g, '').trim();
    if (p.length < 8 || !(ASK.test(p) || (ASK_EXTRA && ASK_EXTRA.test(p)))) continue;
    if (IGNORE_RE && IGNORE_RE.test(p) && !/\byou\b/i.test(p)) continue;
    p = p.replace(/\s+/g, ' ');
    out.push(p.length > 320 ? p.slice(0, 320) + '…' : p);
  }
  return out;
}

// ---------- memory: open items waiting on you ----------
let memCache = { at: 0, items: [] };
async function memoryItems() {
  if (Date.now() - memCache.at < 15000) return memCache.items;
  const items = [];
  try {
    for (const d of await fsp.readdir(PROJ_DIR)) {
      const f = path.join(PROJ_DIR, d, 'memory', 'MEMORY.md');
      let txt; try { txt = await fsp.readFile(f, 'utf8'); } catch { continue; }
      for (const line of txt.split('\n')) {
        if (!line.startsWith('- ') || !MEM_CUE.test(line)) continue;
        const m = line.match(/\[\**([^\]]+?)\**\]\(([^)]+)\)\**\s*[—-]\s*(.*)$/);
        if (!m) continue;
        const title = m[1].replace(/\*\*/g, '');
        if (MEM_SKIP.test(title)) continue;
        const ids = [...line.matchAll(/artifact ([A-Za-z0-9]{18,})/gi)].map(x => 'https://claude.ai/artifact/' + x[1]);
        const tail = m[3];
        const waits = (tail.match(MEM_WAIT) || [])[0] || '';
        if (!waits) continue;
        let mtime = null; try { mtime = (await fsp.stat(path.join(PROJ_DIR, d, 'memory', m[2]))).mtimeMs; } catch {}
        items.push({ project: projectLabel(d), title, waits: waits.trim(), detail: tail.slice(0, 400), artifacts: ids, mtime });
      }
    }
  } catch {}
  items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  memCache = { at: Date.now(), items };
  return items;
}

// ---------- state ----------
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

async function state() {
  let files = [];
  try { files = (await fsp.readdir(SESS_DIR)).filter(f => f.endsWith('.json')); } catch {}
  const sessions = [];
  for (const f of files) {  // one at a time on purpose: keeps peak memory low on the first full read
    let s; try { s = JSON.parse(await fsp.readFile(path.join(SESS_DIR, f), 'utf8')); } catch { continue; }
    if (!s.pid || !alive(s.pid)) continue;
    const tf = s.cwd && s.sessionId ? await findTranscript(s.cwd, s.sessionId) : null;
    let t = null; try { if (tf) t = await transcriptData(tf); } catch {}
    t = t || parseTranscript('');
    const needs = classify(s, t);
    const recapFresh = t.recap && (!t.lastHuman || t.recap.ts >= t.lastHuman.ts) ? t.recap : null;
    const lastTool = s.status === 'busy' && t.lastTool ? { name: t.lastTool.name, desc: t.lastTool.desc, ts: t.lastTool.ts } : null;
    sessions.push({
      pid: s.pid, id: s.sessionId, name: s.name || path.basename(s.cwd || '') || String(s.pid),
      kind: s.kind, status: s.status || 'unknown', cwd: s.cwd, startedAt: s.startedAt,
      statusSince: s.statusUpdatedAt || s.updatedAt || null, version: s.version,
      title: t.customTitle || t.title, goal: t.goal?.text || null, model: t.model,
      you: t.lastHuman, lastPrompt: t.lastPrompt, said: t.lastAssistant, recap: recapFresh,
      now: lastTool, needs, lastActivity: t.lastTs || (t.mtime ? new Date(t.mtime).toISOString() : null),
      prs: [...t.prs.values()].sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, 4),
      artifacts: [...t.artifacts.entries()].sort((a, b) => (b[1] || '').localeCompare(a[1] || '')).slice(0, 4).map(x => x[0]),
    });
  }
  const memory = MEMORY_ON ? await memoryItems() : null;  // null hides the sidebar
  return { at: new Date().toISOString(), host: os.hostname(), sessions, memory };
}

// ---------- server ----------
const PAGE = fs.readFileSync(new URL('./index.html', import.meta.url));
// Extra Host values to accept, e.g. a Tailscale Serve name "<machine>.<tailnet>.ts.net:7357". Default: local only.
const ALLOWED_HOSTS = list(process.env.GLANCE_ALLOWED_HOSTS);
// Tailscale logins allowed through a proxy. When set, every request that came through a proxy (a non-local Host,
// or X-Forwarded-For / Tailscale-* headers) needs a Tailscale-User-Login on this list. Serve sets that header from
// the sender's identity; tagged devices and Funnel (internet) requests have none, so they are refused.
const TS_USERS = list(process.env.GLANCE_TAILSCALE_USERS);
const LOCAL_HOSTS = [`${HOST}:${PORT}`, `localhost:${PORT}`];
function admit(req) {  // → null to serve, or an HTTP status to refuse with
  const h = String(req.headers.host || '').toLowerCase();
  const local = LOCAL_HOSTS.includes(h);
  if (!local && !ALLOWED_HOSTS.includes(h)) return 421;
  const proxied = !local || 'x-forwarded-for' in req.headers || Object.keys(req.headers).some(k => k.startsWith('tailscale-'));
  if (proxied && TS_USERS.length && !TS_USERS.includes(String(req.headers['tailscale-user-login'] || '').toLowerCase())) return 403;
  return null;
}

const server = http.createServer(async (req, res) => {
  const refuse = admit(req);
  if (refuse) { res.writeHead(refuse).end(); return; }
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  const sec = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { ...sec, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" });
    res.end(process.env.GLANCE_DEV ? fs.readFileSync(new URL('./index.html', import.meta.url)) : PAGE); return;
  }
  if (req.url === '/api/state') {
    try {
      const body = JSON.stringify(await state());
      const etag = '"' + crypto.createHash('sha1').update(body.replace(/"at":"[^"]*",/, '')).digest('base64url') + '"';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, sec).end(); return; }
      res.writeHead(200, { ...sec, 'Content-Type': 'application/json', ETag: etag }).end(body);
    } catch (e) { res.writeHead(500, sec).end(String(e?.message || e)); }
    return;
  }
  res.writeHead(404, sec).end();
});
server.listen(PORT, HOST, () => console.log(`glance → http://${HOST}:${PORT}`));
