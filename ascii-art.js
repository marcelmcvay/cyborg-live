'use strict';
// CYBORG LIVE — ASCII art for the room's game (see CONTRACT.md "ASCII ART").
//
// Claude draws a small ASCII picture of the WINNING phrase in each game slot
// (pinned > voted > latest — the same resolution rpg.js uses). Server-side
// only: the API key never reaches a browser. Zero npm deps (Node 18 fetch).
//
// Failure is always silent-to-the-room: no key, timeout, bad output or API
// error -> no art event, and rpg.js keeps its built-in drawings.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_KEY = (process.env['ANTHROPIC_API_KEY'] || '').trim();
const WORKSPACE_ID = (process.env.ANTHROPIC_WORKSPACE_ID || '').trim(); // needed by keys not scoped to a workspace
const BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const MODEL = process.env.ASCII_ART_MODEL || 'claude-haiku-4-5';
const TIMEOUT_MS = Number(process.env.ASCII_ART_TIMEOUT_MS) || 8000;
const MAX_CALLS = Number(process.env.ASCII_ART_MAX_CALLS) || 80; // per process, runaway guard
const DEBOUNCE_MS = 1500;  // votes arrive in bursts; draw what settles
const MAX_COLS = 44;       // fits the /rpg iframe on the projector
const MAX_ROWS = 10;

const SLOT_BRIEF = {
  SETTING: 'a place (the setting of a text adventure)',
  COMPANION: 'a companion character who travels with the player',
  THREAT: 'the threat hunting the player',
  ARTIFACT: 'an object the player can pick up',
  TWIST: 'the twist: a strange rule of this world, drawn as a symbolic scene',
};

let cacheFile = null;
const cache = new Map();     // key -> { slot, text, art, model, ts }
const inflight = new Map();  // key -> Promise
const timers = new Map();    // slot -> debounce timer
let calls = 0;
let lastError = null;

const keyOf = (slot, text) => crypto.createHash('sha1').update(`${slot}\n${text.toLowerCase()}`).digest('hex').slice(0, 16);

function init(dataDir) {
  cacheFile = path.join(dataDir, 'ascii-art.jsonl');
  if (!fs.existsSync(cacheFile)) return 0;
  let n = 0;
  for (const line of fs.readFileSync(cacheFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o.key && o.art) { cache.set(o.key, o); n++; } } catch (_) { /* skip */ }
  }
  return n;
}

// Keep only what renders as a clean monospace block: printable ASCII plus the
// box/block glyphs the game already uses. Strip fences, cap width and height.
function sanitize(raw) {
  let s = String(raw || '').replace(/\r/g, '');
  const fence = s.match(/```[a-z]*\n([\s\S]*?)```/i);
  if (fence) s = fence[1];
  s = s.replace(/\t/g, '  ').replace(/[^\x20-\x7E\n\u2500-\u259F\u00B7]/g, '');
  let lines = s.split('\n').map((l) => l.replace(/\s+$/, '').slice(0, MAX_COLS));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines = lines.slice(0, MAX_ROWS);
  // drop a shared left margin so the block sits flush
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  if (Number.isFinite(indent) && indent > 0) lines = lines.map((l) => l.slice(indent));
  const inked = lines.join('').replace(/\s/g, '').length;
  if (lines.length < 3 || inked < 15) return null; // not a drawing
  return lines.join('\n');
}

async function callClaude(slot, text) {
  const prompt =
    `Draw ${SLOT_BRIEF[slot]} for a live terminal text adventure, projected in a lecture hall.\n` +
    `The audience wrote it: "${text}"\n\n` +
    `Rules: ASCII art only. At most ${MAX_COLS} columns wide and ${MAX_ROWS} lines tall. ` +
    `Interpret the words literally and with wit; make it recognizable from the back of the room. ` +
    `No words or captions inside the drawing. No explanation. Output only the drawing inside one code block.`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01',
        ...(WORKSPACE_ID ? { 'anthropic-workspace-id': WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    const out = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const art = sanitize(out);
    if (!art) throw new Error('response was not usable art');
    return art;
  } finally { clearTimeout(t); }
}

// Resolve art for one phrase: cache, then an in-flight call, then Claude.
async function draw(slot, text) {
  const key = keyOf(slot, text);
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);
  if (!API_KEY || calls >= MAX_CALLS) return null;
  calls++;
  const p = callClaude(slot, text)
    .then((art) => {
      const rec = { key, slot, text, art, model: MODEL, ts: Date.now() };
      cache.set(key, rec);
      if (cacheFile) fs.appendFile(cacheFile, JSON.stringify(rec) + '\n', () => {});
      lastError = null;
      return rec;
    })
    .catch((e) => { lastError = `${slot}: ${e.name === 'AbortError' ? 'timeout' : e.message}`; console.warn(`[ascii-art] ${lastError}`); return null; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Called whenever a slot's winner may have changed. Debounced per slot so a
// burst of votes costs one call for whatever phrase ends up on top.
function schedule(slot, getWinnerText, onArt) {
  clearTimeout(timers.get(slot));
  timers.set(slot, setTimeout(async () => {
    timers.delete(slot);
    const text = getWinnerText(slot);
    if (!text) return;
    const rec = await draw(slot, text);
    // only announce if it is STILL the winner by the time the art lands
    if (rec && getWinnerText(slot) === text) onArt({ slot, text: rec.text, art: rec.art });
  }, DEBOUNCE_MS));
}

// Cached art for the current winners, for /api/state.
function forWinners(getWinnerText, slots) {
  const out = {};
  for (const slot of slots) {
    const text = getWinnerText(slot);
    const rec = text && cache.get(keyOf(slot, text));
    if (rec) out[slot] = { text: rec.text, art: rec.art };
  }
  return out;
}

const status = () => ({ enabled: !!API_KEY, model: MODEL, calls, maxCalls: MAX_CALLS, cached: cache.size, lastError });

module.exports = { init, schedule, draw, forWinners, status, sanitize };
