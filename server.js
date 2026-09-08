'use strict';
// CYBORG LIVE — server. Node 18, zero npm deps. See CONTRACT.md.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 8787;
const ADMIN_KEY = process.env.ADMIN_KEY || 'cyborg';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const SUBMISSIONS_LOG = path.join(DATA_DIR, 'submissions.jsonl');
const ASSEMBLAGES_LOG = path.join(DATA_DIR, 'assemblages.jsonl');
const ROOM_LOG = path.join(DATA_DIR, 'room.jsonl'); // cue / session / stage events
const MAX_BODY = 16 * 1024;
const MAX_SUBMISSIONS_IN_STATE = 200;
const RATE_LIMIT_MS = 3000;
const KINDS = new Set(['question', 'discussion', 'note']);
// cue.mode drives what the phone offers. Order-agnostic: decks reference beats
// by id, never by index, so reordering a deck is a pure JSON edit.
const CUE_MODES = new Set(['intro', 'assemble', 'reveal', 'present', 'panel', 'steward', 'closed']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------- state
const DEFAULT_CUE = Object.freeze({
  beatId: 'intro', label: 'INTRO', mode: 'intro',
  prompt: '', signalOpen: false, assembleOpen: false, ts: 0,
});

const state = {
  submissions: [],            // all submissions in order (incl. hidden)
  assemblages: new Map(),     // sid -> assemblage (latest wins)
  lastSubmitBySid: new Map(), // sid -> ts (rate limiting; not persisted)
  cue: { ...DEFAULT_CUE },    // what the room's phones are currently offering
  session: { n: 1, label: 'SESSION 001', startedAt: Date.now() },
  staged: null,               // submission id thrown full-screen on the deck
};
const sseClients = new Set();

function applySubmissionLine(obj) {
  if (obj.moderate) {
    const s = state.submissions.find((x) => x.id === obj.moderate);
    if (s) s.hidden = !!obj.hidden;
  } else if (obj.id && obj.sid) {
    state.submissions.push(obj);
  }
}
function applyAssemblageLine(obj) {
  if (obj.id && obj.sid) state.assemblages.set(obj.sid, obj);
}
// room.jsonl carries the presenter's control track so a mid-talk crash/restart
// comes back up on the same beat instead of dumping the room back to INTRO.
function applyRoomLine(obj) {
  if (obj.cue) state.cue = obj.cue;
  else if (obj.session) state.session = obj.session;
  else if ('staged' in obj) state.staged = obj.staged;
}

function replayLog(file, apply) {
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { apply(JSON.parse(line)); n++; } catch (e) { console.warn(`[replay] bad line in ${path.basename(file)}: ${e.message}`); }
  }
  return n;
}

function appendLog(file, obj) {
  fs.appendFile(file, JSON.stringify(obj) + '\n', (err) => {
    if (err) console.error(`[persist] ${file}: ${err.message}`);
  });
}

function boot() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const a = replayLog(SUBMISSIONS_LOG, applySubmissionLine);
  const b = replayLog(ASSEMBLAGES_LOG, applyAssemblageLine);
  const c = replayLog(ROOM_LOG, applyRoomLine);
  console.log(`[boot] replayed ${a} submission lines, ${b} assemblage lines, ${c} room lines -> ` +
    `${state.submissions.length} submissions, ${state.assemblages.size} assemblages, ` +
    `${state.session.label} @ cue ${state.cue.beatId}`);
}

// ---------------------------------------------------------------- helpers
function newId() {
  // 8 chars base36 from 48 random bits
  return parseInt(crypto.randomBytes(6).toString('hex'), 16).toString(36).padStart(8, '0').slice(-8);
}

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  // strip control chars (keep nothing below 0x20 except we collapse to space), trim
  return s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanHandle(h) {
  const s = cleanText(h, 24);
  return s || '';
}

function isValidSid(sid) {
  return typeof sid === 'string' && sid.length >= 8 && sid.length <= 64 && /^[\w-]+$/.test(sid);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}
const sendError = (res, status, error) => sendJson(res, status, { error });

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('body too large (16KB max)'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return reject(Object.assign(new Error('empty body'), { status: 400 }));
      try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('expected JSON object');
        resolve(obj);
      } catch (e) {
        reject(Object.assign(new Error('invalid JSON: ' + e.message), { status: 400 }));
      }
    });
    req.on('error', (e) => reject(Object.assign(e, { status: 400 })));
  });
}

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch (_) { sseClients.delete(res); }
  }
}

// ---------------------------------------------------------------- API
function buildState() {
  const visible = state.submissions.filter((s) => !s.hidden);
  const submissions = visible.slice(-MAX_SUBMISSIONS_IN_STATE);
  const assemblages = [...state.assemblages.values()];
  const counts = { question: 0, discussion: 0, note: 0, assemblages: assemblages.length };
  for (const s of visible) if (counts[s.kind] !== undefined) counts[s.kind]++;
  const spectrumHistogram = new Array(10).fill(0);
  const componentTally = {};
  for (const a of assemblages) {
    const b = Math.min(9, Math.max(0, Math.floor(a.spectrum / 10)));
    spectrumHistogram[b]++;
    for (const id of a.picks) componentTally[id] = (componentTally[id] || 0) + 1;
  }
  return {
    submissions, assemblages, counts, spectrumHistogram, componentTally,
    cue: state.cue, session: state.session, staged: state.staged,
  };
}

// --- presenter control track (cue / reset / stage) — all admin-key gated ----
function requireKey(body, res) {
  if (typeof body.key !== 'string' || body.key !== ADMIN_KEY) {
    sendError(res, 403, 'forbidden: bad key');
    return false;
  }
  return true;
}

async function handleCue(req, res) {
  const body = await readJsonBody(req);
  if (!requireKey(body, res)) return;
  const mode = typeof body.mode === 'string' ? body.mode : '';
  if (!CUE_MODES.has(mode)) {
    return sendError(res, 400, `mode must be one of ${[...CUE_MODES].join('|')}`);
  }
  const beatId = cleanText(body.beatId, 64);
  if (!beatId) return sendError(res, 400, 'beatId required');
  const cue = {
    beatId,
    label: cleanText(body.label, 48) || mode.toUpperCase(),
    mode,
    prompt: cleanText(body.prompt, 280),
    // Explicit booleans: the deck decides what the room can do, not the mode name.
    signalOpen: !!body.signalOpen,
    assembleOpen: !!body.assembleOpen,
    ts: Date.now(),
  };
  state.cue = cue;
  appendLog(ROOM_LOG, { cue });
  broadcast('cue', cue);
  sendJson(res, 200, { ok: true, cue });
}

async function handleStage(req, res) {
  const body = await readJsonBody(req);
  if (!requireKey(body, res)) return;
  if (body.id === null || body.id === '') {
    state.staged = null;
    appendLog(ROOM_LOG, { staged: null });
    broadcast('staged', { staged: null });
    return sendJson(res, 200, { ok: true, staged: null });
  }
  if (typeof body.id !== 'string') return sendError(res, 400, 'id required (or null to clear)');
  const sub = state.submissions.find((s) => s.id === body.id);
  if (!sub) return sendError(res, 404, 'submission not found');
  state.staged = sub.id;
  appendLog(ROOM_LOG, { staged: sub.id });
  broadcast('staged', { staged: sub.id, submission: sub });
  sendJson(res, 200, { ok: true, staged: sub.id });
}

// Reset = start a NEW named session. Rotates the logs into an archive rather
// than deleting them, so Design Week's room survives running Miami off this box.
async function handleReset(req, res) {
  const body = await readJsonBody(req);
  if (!requireKey(body, res)) return;
  const n = state.session.n + 1;
  const label = cleanText(body.label, 48) || `SESSION ${String(n).padStart(3, '0')}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archived = [];
  for (const f of [SUBMISSIONS_LOG, ASSEMBLAGES_LOG, ROOM_LOG]) {
    if (!fs.existsSync(f)) continue;
    const dest = path.join(DATA_DIR, `${path.basename(f, '.jsonl')}.${stamp}.jsonl`);
    try { fs.renameSync(f, dest); archived.push(path.basename(dest)); }
    catch (e) { console.error(`[reset] archive ${f}: ${e.message}`); }
  }
  state.submissions = [];
  state.assemblages.clear();
  state.lastSubmitBySid.clear();
  state.staged = null;
  state.cue = { ...DEFAULT_CUE, ts: Date.now() };
  state.session = { n, label, startedAt: Date.now() };
  appendLog(ROOM_LOG, { session: state.session });
  appendLog(ROOM_LOG, { cue: state.cue });
  console.log(`[reset] -> ${label} (archived ${archived.length} logs)`);
  broadcast('reset', { session: state.session, cue: state.cue });
  sendJson(res, 200, { ok: true, session: state.session, archived });
}

async function handleSubmit(req, res) {
  const body = await readJsonBody(req);
  const { sid, kind } = body;
  if (!isValidSid(sid)) return sendError(res, 400, 'sid required (8-64 chars, [A-Za-z0-9_-])');
  if (!KINDS.has(kind)) return sendError(res, 400, 'kind must be question|discussion|note');
  const text = cleanText(body.text, 280);
  if (!text) return sendError(res, 400, 'text required (1..280 chars)');
  const now = Date.now();
  const last = state.lastSubmitBySid.get(sid) || 0;
  if (now - last < RATE_LIMIT_MS) {
    const wait = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
    res.setHeader('Retry-After', String(wait));
    return sendError(res, 429, `rate limited: 1 submission per 3s (retry in ${wait}s)`);
  }
  state.lastSubmitBySid.set(sid, now);
  const sub = { id: newId(), ts: now, sid, handle: cleanHandle(body.handle), kind, text, hidden: false };
  state.submissions.push(sub);
  appendLog(SUBMISSIONS_LOG, sub);
  broadcast('submission', sub);
  sendJson(res, 201, { id: sub.id, ts: sub.ts });
}

async function handleAssemblage(req, res) {
  const body = await readJsonBody(req);
  const { sid } = body;
  if (!isValidSid(sid)) return sendError(res, 400, 'sid required (8-64 chars, [A-Za-z0-9_-])');
  if (!Array.isArray(body.picks) || body.picks.length > 64) return sendError(res, 400, 'picks must be an array (max 64)');
  const picks = [...new Set(body.picks.filter((p) => typeof p === 'string').map((p) => cleanText(p, 48)).filter(Boolean))];
  const spectrum = Number(body.spectrum);
  if (!Number.isFinite(spectrum) || spectrum < 0 || spectrum > 100) return sendError(res, 400, 'spectrum must be a number 0..100');
  const klass = cleanText(body.klass, 48);
  if (!klass) return sendError(res, 400, 'klass required');
  const asm = {
    id: newId(), ts: Date.now(), sid, handle: cleanHandle(body.handle),
    picks, spectrum: Math.round(spectrum * 10) / 10, klass,
  };
  state.assemblages.set(sid, asm);
  appendLog(ASSEMBLAGES_LOG, asm);
  broadcast('assemblage', asm);
  sendJson(res, 201, { id: asm.id, ts: asm.ts });
}

async function handleModerate(req, res) {
  const body = await readJsonBody(req);
  if (typeof body.key !== 'string' || body.key !== ADMIN_KEY) return sendError(res, 403, 'forbidden: bad key');
  if (typeof body.id !== 'string') return sendError(res, 400, 'id required');
  if (typeof body.hidden !== 'boolean') return sendError(res, 400, 'hidden must be boolean');
  const sub = state.submissions.find((s) => s.id === body.id);
  if (!sub) return sendError(res, 404, 'submission not found');
  sub.hidden = body.hidden;
  appendLog(SUBMISSIONS_LOG, { moderate: sub.id, hidden: sub.hidden, ts: Date.now() });
  broadcast('moderate', { id: sub.id, hidden: sub.hidden });
  sendJson(res, 200, { ok: true, id: sub.id, hidden: sub.hidden });
}

function handleFeed(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 2000\n\n'); // no historical data; client fetches /api/state first
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}
setInterval(() => broadcast('ping', { ts: Date.now() }), 20000).unref();

// ---------------------------------------------------------------- static
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  else if (pathname === '/presenter' || pathname === '/presenter/') pathname = '/presenter.html';
  else if (pathname === '/deck' || pathname === '/deck/') pathname = '/deck.html';
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (_) { return sendError(res, 400, 'bad path'); }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendError(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendError(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
    if (p.startsWith('/api/')) {
      if (p === '/api/submit' && req.method === 'POST') return await handleSubmit(req, res);
      if (p === '/api/assemblage' && req.method === 'POST') return await handleAssemblage(req, res);
      if (p === '/api/moderate' && req.method === 'POST') return await handleModerate(req, res);
      if (p === '/api/cue' && req.method === 'POST') return await handleCue(req, res);
      if (p === '/api/stage' && req.method === 'POST') return await handleStage(req, res);
      if (p === '/api/reset' && req.method === 'POST') return await handleReset(req, res);
      if (p === '/api/state' && req.method === 'GET') return sendJson(res, 200, buildState());
      if (p === '/api/feed' && req.method === 'GET') return handleFeed(req, res);
      if (p === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, uptime: process.uptime(), sse: sseClients.size });
      }
      return sendError(res, 404, 'unknown API route');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed');
    return serveStatic(req, res, p);
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    if (status === 500) console.error('[error]', req.method, p, e);
    if (!res.headersSent) sendError(res, status, e.message || 'internal error');
    else res.end();
  }
});

boot();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[cyborg-live] listening on http://0.0.0.0:${PORT}  (admin key ${ADMIN_KEY === 'cyborg' ? 'DEFAULT' : 'set'})`);
});

function shutdown(sig) {
  console.log(`[cyborg-live] ${sig} — shutting down`);
  for (const c of sseClients) c.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
