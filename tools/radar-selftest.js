'use strict';
// Self-test for public/radar.js. ZERO deps (repo rule): implements the tiny
// slice of DOM that radar.js touches, loads the real file, and asserts the
// invariants from the participation-instrument design rules.
//
//   node tools/radar-selftest.js     -> prints PASS/FAIL per check, exits 1 on any FAIL

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------- DOM shim
class El {
  constructor(tag) {
    this.tagName = tag;
    this.attrs = {};
    this.children = [];
    this.textContent = '';
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...c) { this.children = c; }
  // depth-first collect by class token
  find(cls) {
    const out = [];
    const walk = (n) => {
      const c = (n.attrs && n.attrs.class) || '';
      if (c.split(/\s+/).includes(cls)) out.push(n);
      (n.children || []).forEach(walk);
    };
    walk(this);
    return out;
  }
}
class Frag extends El { constructor() { super('#fragment'); } }

const document = {
  createElementNS: (_ns, tag) => new El(tag),
  createDocumentFragment: () => new Frag(),
};

const sandbox = { document, window: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'radar.js'), 'utf8');
vm.runInContext(src, sandbox);
const Radar = sandbox.window.Radar;

// ---------------------------------------------------------------- fixtures
const cat = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'public', 'components.v2.json'), 'utf8'));
const ORDER = cat.aggregation.axisOrder;
const byId = new Map(cat.components.map((c) => [c.id, c]));

let fails = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const avgR = (v) => ORDER.reduce((a, ax) => a + (+v[ax] || 0), 0) / ORDER.length;

// 1. Radar loaded and exports its API
check('radar.js exports API',
  Radar && typeof Radar.render === 'function' && typeof Radar.meanVector === 'function');

// 2. MEAN not SUM — average radius must stay flat as pick count grows.
//    If this drifts upward, more picks = bigger polygon = the scoreboard is back.
{
  const ids = [...byId.keys()];
  let prng = 12345;
  const rnd = () => (prng = (prng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sampleAvg = (k) => {
    let tot = 0; const runs = 300;
    for (let r = 0; r < runs; r++) {
      const pool = [...ids];
      const pick = [];
      for (let i = 0; i < k; i++) pick.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
      tot += avgR(Radar.meanVector(pick.map((i) => byId.get(i)), ORDER));
    }
    return tot / runs;
  };
  const a1 = sampleAvg(1); const a5 = sampleAvg(5); const a8 = sampleAvg(8); const a20 = sampleAvg(20);
  const spread = Math.max(a1, a5, a8, a20) - Math.min(a1, a5, a8, a20);
  check('MEAN aggregation: avg radius flat vs pick count', spread < 3.0,
    `1:${a1.toFixed(1)} 5:${a5.toFixed(1)} 8:${a8.toFixed(1)} 20:${a20.toFixed(1)} spread ${spread.toFixed(2)}`);
}

// 3. Empty selection is a collapsed polygon, not NaN
{
  const v = Radar.meanVector([], ORDER);
  const clean = ORDER.every((ax) => v[ax] === 0);
  check('empty selection -> all-zero vector (no NaN)', clean, JSON.stringify(v));
}

// 4. FIXED spoke order: reversing axisOrder must change the rendered geometry.
//    Proves order is load-bearing, which is why it must never be sorted.
{
  const picks = ['cog.llm', 'craft.figma', 'veh.car'].map((i) => byId.get(i));
  const v = Radar.meanVector(picks, ORDER);
  const p1 = Radar.polygonPoints(v, ORDER, 100, 100, 80);
  const p2 = Radar.polygonPoints(v, [...ORDER].reverse(), 100, 100, 80);
  check('axis order is load-bearing (reverse changes silhouette)', p1 !== p2);
}

// 5. Spoke 0 points straight up
{
  const a = Radar.spokeAngle(0, 7);
  check('spoke 0 at -90deg (points up)', Math.abs(a + Math.PI / 2) < 1e-9, `${a}`);
}

// 6. Value 100 lands on the outer ring radius; 0 lands at centre
{
  const full = {}; const zero = {};
  for (const ax of ORDER) { full[ax] = 100; zero[ax] = 0; }
  const pf = Radar.polygonPoints(full, ORDER, 100, 100, 80).split(' ')[0].split(',').map(Number);
  const pz = Radar.polygonPoints(zero, ORDER, 100, 100, 80).split(' ')[0].split(',').map(Number);
  const rf = Math.hypot(pf[0] - 100, pf[1] - 100);
  const rz = Math.hypot(pz[0] - 100, pz[1] - 100);
  check('value 100 -> outer radius, 0 -> centre',
    Math.abs(rf - 80) < 0.05 && rz < 0.05, `r(100)=${rf.toFixed(2)} r(0)=${rz.toFixed(2)}`);
}

// 7. Out-of-range values are clamped, never projected outside the web
{
  const wild = {};
  for (const ax of ORDER) wild[ax] = 400;
  const pts = Radar.polygonPoints(wild, ORDER, 100, 100, 80).split(' ');
  const maxR = Math.max(...pts.map((p) => {
    const [x, y] = p.split(',').map(Number);
    return Math.hypot(x - 100, y - 100);
  }));
  check('values clamped to 0..100', maxR <= 80.05, `maxR ${maxR.toFixed(2)}`);
}

// 8. pickCount drives fill OPACITY only — radius must be identical
{
  const picks = ['cog.llm', 'craft.figma'].map((i) => byId.get(i));
  const v = Radar.meanVector(picks, ORDER);
  const mk = (n) => Radar.render({
    vector: v, axes: cat.axes, axisOrder: ORDER, pickCount: n, size: 320,
  });
  const s2 = mk(2); const s20 = mk(20);
  const shape = (s) => s.find('radar__shape')[0];
  const same = shape(s2).attrs.points === shape(s20).attrs.points;
  const diffOpacity = shape(s2).attrs['fill-opacity'] !== shape(s20).attrs['fill-opacity'];
  check('pick count changes opacity, NOT geometry', same && diffOpacity,
    `op2=${shape(s2).attrs['fill-opacity']} op20=${shape(s20).attrs['fill-opacity']}`);
}

// 9. Ghost polygons render UNDER the live shape (draw order = stacking)
{
  const picks = [byId.get('cog.llm')];
  const svg = Radar.render({
    vector: Radar.meanVector(picks, ORDER), axes: cat.axes, axisOrder: ORDER,
    ghosts: cat.ghosts.filter((g) => g.id !== 'ghost.room'), pickCount: 1, size: 320,
  });
  const flat = [];
  (function walk(n) { flat.push(n); (n.children || []).forEach(walk); })(svg);
  const gi = flat.findIndex((n) => (n.attrs.class || '') === 'radar__ghost');
  const si = flat.findIndex((n) => (n.attrs.class || '').startsWith('radar__shape'));
  check('ghosts drawn before (under) live shape', gi >= 0 && si >= 0 && gi < si, `ghost@${gi} shape@${si}`);
}

// 10. Room aggregate: MEAN of participant vectors does not grow with N
{
  const p1 = Radar.meanVector([byId.get('body.insulin')], ORDER);
  const p2 = Radar.meanVector([byId.get('veh.car')], ORDER);
  const p3 = Radar.meanVector([byId.get('cog.llm')], ORDER);
  const r2 = avgR(Radar.meanOfVectors([p1, p2], ORDER));
  const r6 = avgR(Radar.meanOfVectors([p1, p2, p3, p1, p2, p3], ORDER));
  check('room MEAN stable as participants repeat', Math.abs(r2 - avgR(Radar.meanOfVectors([p1, p2, p1, p2], ORDER))) < 1e-6,
    `N=2 ${r2.toFixed(2)} vs N=4(dup) equal`);
  check('room aggregate never inflates past axis max', r6 <= 100);
}

// 11. Accessibility: alt text carries the numbers, not just "a chart"
{
  const svg = Radar.render({
    vector: Radar.meanVector([byId.get('cog.llm')], ORDER),
    axes: cat.axes, axisOrder: ORDER, pickCount: 1, size: 320,
  });
  const alt = svg.attrs['aria-label'] || '';
  check('aria-label includes per-axis values', /Dependence \d+/.test(alt), alt.slice(0, 80) + '…');
}

// 12. Every component and ghost has a full, in-range vector
{
  let bad = [];
  for (const c of cat.components) {
    for (const ax of ORDER) {
      const n = c.vector ? c.vector[ax] : undefined;
      if (typeof n !== 'number' || n < 0 || n > 100) bad.push(`${c.id}.${ax}`);
    }
  }
  // ghost.room is a placeholder for the LIVE room aggregate — it is computed
  // from real assemblages at runtime and carries no authored vector. All three
  // consumers filter it out of the ghost set, so it is excluded here too.
  for (const g of cat.ghosts.filter((x) => x.id !== 'ghost.room')) {
    for (const ax of ORDER) {
      const n = g.vector ? g.vector[ax] : undefined;
      if (typeof n !== 'number' || n < 0 || n > 100) bad.push(`${g.id}.${ax}`);
    }
  }
  check('all vectors complete and in 0..100', bad.length === 0, bad.slice(0, 5).join(', '));
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
