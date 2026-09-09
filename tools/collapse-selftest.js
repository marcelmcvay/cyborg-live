'use strict';
// Verifies the telemetry collapse logic in presenter.js: persistence round-trip,
// stale/garbage localStorage handling, and that the collapsed set only ever
// contains real module keys. Zero deps, no browser.
//
//   node tools/collapse-selftest.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'presenter.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'presenter.html'), 'utf8');

function extract(name) {
  const start = src.indexOf(`  function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// ---- fake panels mirroring the real markup's data-module / data-collapse pairs
const MODULES = [...html.matchAll(/data-module="([^"]+)"/g)].map((m) => m[1]);
const TOGGLES = [...html.matchAll(/data-collapse="([^"]+)"/g)].map((m) => m[1]);

function makePanel(key, hasToggle) {
  const btn = hasToggle ? {
    dataset: { collapse: key },
    attrs: {},
    handlers: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(ev, fn) { if (ev === 'click') this.handlers.push(fn); },
    click() { this.handlers.forEach((fn) => fn()); },
  } : null;
  return {
    dataset: { module: key },
    classes: new Set(),
    btn,
    classList: {
      toggle(cls, on) { if (on) this.owner.classes.add(cls); else this.owner.classes.delete(cls); },
    },
  };
}

let store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};

function buildSandbox() {
  const panels = MODULES.map((k) => {
    const p = makePanel(k, TOGGLES.includes(k));
    p.classList.owner = p;
    return p;
  });
  const sb = {
    localStorage,
    S: { collapsed: new Set() },
    $$: (sel) => (sel === '[data-module]' ? panels
      : sel === '[data-collapse]' ? panels.filter((p) => p.btn).map((p) => p.btn)
        : []),
    $: (sel, root) => (sel === '[data-collapse]' ? (root && root.btn) || null : null),
    status: () => {},
    renderRoomRadar: () => { sb.__radarRendered = (sb.__radarRendered || 0) + 1; },
    __panels: panels,
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext([
    "const COLLAPSE_LS = 'cyborg.collapsed';",
    extract('loadCollapsed'), extract('saveCollapsed'),
    extract('applyCollapsed'), extract('toggleModule'), extract('initCollapse'),
  ].join('\n'), sb);
  return sb;
}

let fails = 0;
const check = (n, c, d) => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); };
const isCollapsed = (sb, key) => sb.__panels.find((p) => p.dataset.module === key).classes.has('is-collapsed');

// 1. markup sanity: every toggle points at a real module
check('every data-collapse matches a data-module', TOGGLES.every((t) => MODULES.includes(t)),
  `toggles=${TOGGLES.join(',')} modules=${MODULES.join(',')}`);
check('counters has no toggle (always visible)', !TOGGLES.includes('counters'));

// 2. default state: nothing collapsed
{
  store = {};
  const sb = buildSandbox();
  sb.initCollapse();
  check('fresh state -> all modules expanded', MODULES.every((k) => !isCollapsed(sb, k)));
}

// 3. toggle collapses, sets aria-expanded=false, and persists
{
  store = {};
  const sb = buildSandbox();
  sb.initCollapse();
  sb.toggleModule('tally');
  const btn = sb.__panels.find((p) => p.dataset.module === 'tally').btn;
  check('toggle collapses the module', isCollapsed(sb, 'tally'));
  check('aria-expanded reflects collapsed state', btn.attrs['aria-expanded'] === 'false', btn.attrs['aria-expanded']);
  check('collapsed set persisted to localStorage',
    JSON.parse(store['cyborg.collapsed']).includes('tally'), store['cyborg.collapsed']);
  check('other modules unaffected', !isCollapsed(sb, 'radar') && !isCollapsed(sb, 'klass'));
}

// 4. persistence round-trip across a reload
{
  store = { 'cyborg.collapsed': JSON.stringify(['radar', 'klass']) };
  const sb = buildSandbox();
  sb.initCollapse();
  check('reload restores collapsed modules', isCollapsed(sb, 'radar') && isCollapsed(sb, 'klass'));
  check('reload leaves others expanded', !isCollapsed(sb, 'tally'));
}

// 5. expanding the radar must re-render it (zero-size SVG otherwise)
{
  store = { 'cyborg.collapsed': JSON.stringify(['radar']) };
  const sb = buildSandbox();
  sb.initCollapse();
  const before = sb.__radarRendered || 0;
  sb.toggleModule('radar'); // expand
  check('expanding radar triggers re-render', (sb.__radarRendered || 0) > before,
    `renders ${before} -> ${sb.__radarRendered || 0}`);
  const after = sb.__radarRendered || 0;
  sb.toggleModule('radar'); // collapse again
  check('collapsing radar does not re-render', (sb.__radarRendered || 0) === after);
}

// 6. garbage / stale localStorage must not throw or collapse anything real
{
  for (const bad of ['not json', '{"a":1}', 'null', '[1,2,3]', '["ghostmodule"]']) {
    store = { 'cyborg.collapsed': bad };
    let threw = false;
    let sb;
    try { sb = buildSandbox(); sb.initCollapse(); } catch { threw = true; }
    const anyRealCollapsed = !threw && MODULES.some((k) => isCollapsed(sb, k));
    check(`garbage localStorage ${JSON.stringify(bad)} survives`, !threw && !anyRealCollapsed);
  }
}

// 7. idempotency: toggling twice returns to the original state
{
  store = {};
  const sb = buildSandbox();
  sb.initCollapse();
  sb.toggleModule('klass');
  sb.toggleModule('klass');
  check('toggle twice -> expanded again', !isCollapsed(sb, 'klass'));
  check('persisted set empty again', JSON.parse(store['cyborg.collapsed']).length === 0);
}

// 8. the wired CLICK path works, not just direct calls — this is what the
//    operator actually does, and a missing listener would be invisible above.
{
  store = {};
  const sb = buildSandbox();
  sb.initCollapse();
  const btn = sb.__panels.find((p) => p.dataset.module === 'tally').btn;
  check('click listener was registered', btn.handlers.length === 1, `${btn.handlers.length} handlers`);
  btn.click();
  check('clicking the header collapses the module', isCollapsed(sb, 'tally'));
  btn.click();
  check('clicking again expands it', !isCollapsed(sb, 'tally'));
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
