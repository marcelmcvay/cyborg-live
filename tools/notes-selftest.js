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
  el: { notes: notesEl, notesBeat: { textContent: '' }, notesSlide: { textContent: '' } },
  // slide position the presenter believes the projector is on
  S: { slideIdx: 0, pendingSlideIdx: null },
  shownSlideIdx() { return sandbox.S.pendingSlideIdx == null ? sandbox.S.slideIdx : sandbox.S.pendingSlideIdx; },
  $: () => null,           // scrollIntoView lookup; null is the no-op path
  REDUCED_MOTION: true,
  esc: (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;'),
  pad: (n, w = 3) => String(n).padStart(w, '0'),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${extract('slideCaption')}\n${extract('renderNotes')}`, sandbox);
const setLive = (i) => { sandbox.S.slideIdx = i; sandbox.S.pendingSlideIdx = null; };

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

// 9. Slide blocks are BUTTONS carrying data-slide, so they can drive the deck
{
  setLive(0);
  sandbox.renderNotes({
    id: 't', label: 'T',
    slides: [{ kind: 'statement', text: 'A' }, { kind: 'statement', text: 'B' }, { kind: 'radar' }],
    presenterNotes: 'prose',
  });
  const html = notesEl.innerHTML;
  const idxs = [...html.matchAll(/data-slide="(\d+)"/g)].map((m) => m[1]);
  check('every slide block carries data-slide in order', idxs.join() === '0,1,2', idxs.join());
  check('slide blocks are <button> (clickable)',
    (html.match(/<button type="button" class="nb nb--slide/g) || []).length === 3);
  check('beat block is NOT a button', /class="nb nb--beat"/.test(html) && !/<button[^>]*nb--beat/.test(html));
}

// 10. The live slide is marked, and only one is
{
  const deck = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'decks', 'design-week-ri.json'), 'utf8'));
  const beat = deck.beats.find((b) => b.id === 'reveal');
  for (const i of [0, 1, 2, 3]) {
    setLive(i);
    sandbox.renderNotes(beat);
    const html = notesEl.innerHTML;
    const liveCount = (html.match(/ is-live"/g) || []).length;
    const onLive = [...html.matchAll(/data-slide="(\d+)" aria-current="true"/g)].map((m) => Number(m[1]));
    check(`slide ${i} live -> exactly one is-live on the right block`,
      liveCount === 1 && onLive.length === 1 && onLive[0] === i, `live=${liveCount} at ${onLive.join()}`);
  }
}

// 11. ON SCREEN badge + aria-current present for the live block only
{
  setLive(1);
  sandbox.renderNotes({ id: 't', label: 'T', slides: [{ kind: 'statement', text: 'A' }, { kind: 'statement', text: 'B' }] });
  const html = notesEl.innerHTML;
  check('ON SCREEN badge appears once', (html.match(/ON SCREEN/g) || []).length === 1);
  check('aria-current true appears once', (html.match(/aria-current="true"/g) || []).length === 1);
  check('aria-current false on the other block', (html.match(/aria-current="false"/g) || []).length === 1);
}

// 12. Slide readout in the header tracks position and total
{
  setLive(2);
  sandbox.renderNotes({ id: 't', label: 'T', slides: [{ kind: 'prompt', text: 'a' }, { kind: 'prompt', text: 'b' }, { kind: 'prompt', text: 'c' }] });
  check('header slide readout reflects live position',
    sandbox.el.notesSlide.textContent === 'SLIDE 03/03', sandbox.el.notesSlide.textContent);
  sandbox.renderNotes({ id: 'e', label: 'E', slides: [] });
  check('no slides -> readout blanked', sandbox.el.notesSlide.textContent === 'SLIDE —/—', sandbox.el.notesSlide.textContent);
}

// 13. Note bodies use spans, not <p> (invalid inside <button>)
{
  setLive(0);
  sandbox.renderNotes({ id: 't', label: 'T', slides: [{ kind: 'statement', text: 'A', note: 'one\n\ntwo' }] });
  const btn = notesEl.innerHTML.match(/<button[\s\S]*?<\/button>/)[0];
  check('no <p> inside the slide button', !/<p[ >]/.test(btn));
  check('paragraphs split into nb__p spans', (btn.match(/class="nb__p"/g) || []).length === 2);
}

// 14. An out-of-range live index must not mark anything (no crash, no ghost)
{
  setLive(99);
  sandbox.renderNotes({ id: 't', label: 'T', slides: [{ kind: 'statement', text: 'A' }] });
  check('out-of-range live index marks nothing', !/ is-live"/.test(notesEl.innerHTML));
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
