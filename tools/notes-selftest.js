'use strict';
// Verifies renderNotes() block structure against the REAL decks, without a
// browser. Extracts the two pure functions from presenter.js by evaluating the
// file in a sandbox with a minimal DOM, then asserts on generated markup.
//
//   node tools/notes-selftest.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'presenter.js'), 'utf8');

// Pull the two functions we want to exercise out of the IIFE. They are pure
// apart from writing into el.notes / el.notesBeat, which the shim supplies.
function extract(name) {
  const start = src.indexOf(`  function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in presenter.js`);
  // walk braces to find the end of the function
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const notesEl = { innerHTML: '', scrollTop: 0 };
const sandbox = {
  el: { notes: notesEl, notesBeat: { textContent: '' } },
  esc: (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;'),
  pad: (n, w = 3) => String(n).padStart(w, '0'),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${extract('slideCaption')}\n${extract('renderNotes')}`, sandbox);

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const countBlocks = (html, cls) => (html.match(new RegExp(`class="nb nb--${cls}`, 'g')) || []).length;

// 1. No beat cued -> explicit empty state, never blank
{
  sandbox.renderNotes(null);
  check('null beat -> empty-state copy', /NO BEAT CUED/.test(notesEl.innerHTML));
}

// 2. Every beat in both real decks renders one block per slide (+1 beat block)
for (const slug of ['design-week-ri', 'miami']) {
  const deck = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'decks', `${slug}.json`), 'utf8'));
  let allOk = true; let detail = '';
  for (const beat of deck.beats) {
    sandbox.renderNotes(beat);
    const html = notesEl.innerHTML;
    const slideBlocks = countBlocks(html, 'slide');
    const beatBlocks = countBlocks(html, 'beat');
    const want = beat.slides.length;
    if (slideBlocks !== want) { allOk = false; detail = `${beat.id}: ${slideBlocks} blocks for ${want} slides`; break; }
    if (beat.presenterNotes && beatBlocks !== 1) { allOk = false; detail = `${beat.id}: beat block missing`; break; }
    // numbering must be 01..N in order
    const nums = [...html.matchAll(/class="nb__n readout">(\d+)</g)].map((m) => m[1]);
    const expect = beat.slides.map((_, i) => String(i + 1).padStart(2, '0'));
    if (nums.join() !== expect.join()) { allOk = false; detail = `${beat.id}: numbering ${nums.join()} != ${expect.join()}`; break; }
  }
  check(`${slug}: one block per slide, numbered in order`, allOk, detail);
}

// 3. Captions surface the projector's own words
{
  sandbox.renderNotes({
    id: 't', label: 'T',
    slides: [{ kind: 'statement', text: 'Designed by systems.' }],
    presenterNotes: '',
  });
  check('caption shows slide text', /Designed by systems\./.test(notesEl.innerHTML));
}

// 4. Live slides (no authored text) still get a descriptive caption
{
  for (const [kind, want] of [['radar', 'live room radar'], ['histogram', 'live dependence histogram'], ['staged', 'staged audience card']]) {
    const cap = sandbox.slideCaption({ kind });
    check(`caption for live kind '${kind}'`, cap === want, cap);
  }
}

// 5. Per-slide note renders in its own block body
{
  sandbox.renderNotes({
    id: 't', label: 'T',
    slides: [
      { kind: 'statement', text: 'A', note: 'SAY THIS FIRST' },
      { kind: 'statement', text: 'B' },
    ],
    presenterNotes: 'beat level prose',
  });
  const html = notesEl.innerHTML;
  check('slide.note renders in its block', /SAY THIS FIRST/.test(html));
  check('note-less slide marked is-bare', /nb--slide is-bare/.test(html));
  check('beat prose renders as BEAT block', countBlocks(html, 'beat') === 1);
}

// 6. XSS: authored deck content is escaped, never injected
{
  sandbox.renderNotes({
    id: 'x', label: '<img src=x onerror=1>',
    slides: [{ kind: 'statement', text: '<script>alert(1)</script>', note: '<b>bold</b>' }],
    presenterNotes: '<script>bad()</script>',
  });
  const html = notesEl.innerHTML;
  check('no raw <script> in output', !/<script>/.test(html));
  check('no raw onerror in output', !/onerror=/.test(html));
  check('markup escaped to entities', /&lt;script&gt;/.test(html));
}

// 7. Beat with slides but no notes anywhere still renders (blocks, not empty)
{
  sandbox.renderNotes({ id: 'z', label: 'Z', slides: [{ kind: 'prompt', text: 'Q?' }] });
  check('slides w/o any notes still render blocks', countBlocks(notesEl.innerHTML, 'slide') === 1);
}

// 8. Beat with neither slides nor notes -> empty state
{
  sandbox.renderNotes({ id: 'e', label: 'E', slides: [] });
  check('no slides + no notes -> empty state', /NO NOTES FOR THIS BEAT/.test(notesEl.innerHTML));
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
