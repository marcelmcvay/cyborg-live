/* ═══════════════════════════════════════════════════════════════════
   CYBORG // LIVE — presenter.js
   Big-screen view. Vanilla ES2020, no deps.
   Data: GET /api/state on boot, then EventSource /api/feed.
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────
  // All paths RELATIVE — this screen has to survive being served under a
  // reverse-proxy prefix like /cyborg/.
  const API = {
    state: 'api/state',
    feed: 'api/feed',
    moderate: 'api/moderate',
    cue: 'api/cue',
    stage: 'api/stage',
  };
  const ADMIN_KEY_LS = 'cyborg.adminKey';
  const T0_LS = 'cyborg.t0';          // ms epoch of "talk starts now"
  const DEFAULT_DECK = 'design-week-ri';
  const MAX_CARDS = 60;               // DOM cap; feed is newest-first
  const KINDS = ['question', 'discussion', 'note'];
  const SPECTRUM_LABELS = ['DAILY DESIGNER', 'RACE CAR DRIVER', 'PILOT', 'ASTRONAUT', 'VADER'];
  const KLASS_ROTATE_MS = 8000;
  const BACKOFF = { base: 1000, max: 30000 };
  const OVER_HARD = 1.35;             // >135% of budget = --danger
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── State ────────────────────────────────────────────────────────
  const S = {
    submissions: [],        // newest first, hidden excluded
    assemblages: [],        // one per sid, newest last (as delivered)
    counts: { question: 0, discussion: 0, note: 0, assemblages: 0 },
    spectrumHistogram: new Array(10).fill(0),
    componentTally: {},
    componentLabels: {},    // id -> label (from components.v2.json)
    axes: [],               // radar axis metadata
    axisOrder: [],          // FIXED spoke order — never sort by value
    ghosts: [],             // authored reference polygons (Vader, farmer, ...)
    filter: 'all',
    modVisible: true,
    link: 'offline',        // offline | linking | live
    es: null,
    backoff: BACKOFF.base,
    reconnectTimer: null,
    klassIdx: 0,
    klassTimer: null,
    // ── control track ──
    deck: null,             // loaded deck JSON
    beats: [],              // deck.beats with a string id, in authored order
    cue: null,              // authoritative room cue (server / SSE)
    pendingBeatId: null,    // optimistic: pressed, POST not resolved yet
    beatStartTs: 0,         // when the current beat was cued (ms epoch)
    t0: 0,                  // talk start (ms epoch) for the total clock
    staged: null,           // submission id currently full-screen on the deck
    session: null,
    clockTimer: null,
    tab: 'control',         // control | notes | signal
  };

  // ── DOM ──────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const el = {
    body: document.body,
    joinUrl: $('#joinUrl'),
    linkPill: $('#linkPill'),
    clock: $('#clock'),
    cards: $('#cards'),
    feedEmpty: $('#feedEmpty'),
    filters: $$('.filter'),
    cSignals: $('#cSignals'),
    cAssemblages: $('#cAssemblages'),
    hist: $('#hist'),

    roomRadar: $('#roomRadar'),
    roomRadarMeta: $('#roomRadarMeta'),

    tally: $('#tally'),
    tallyEmpty: $('#tallyEmpty'),
    klassBody: $('#klassBody'),
    klassIdx: $('#klassIdx'),
    klassHandle: $('#klassHandle'),
    klassPicks: $('#klassPicks'),
    klassSpectrum: $('#klassSpectrum'),
    ftrStatus: $('#ftrStatus'),
    // control track
    hdrSession: $('#hdrSession'),
    ctrlDeck: $('#ctrlDeck'),
    ctrlErr: $('#ctrlErr'),
    now: $('#now'),
    nowIdx: $('#nowIdx'),
    nowLabel: $('#nowLabel'),
    nowPrompt: $('#nowPrompt'),
    nowWarn: $('#nowWarn'),
    beatElapsed: $('#beatElapsed'),
    beatBudget: $('#beatBudget'),
    beatClockBox: $('#beatClockBox'),
    totalElapsed: $('#totalElapsed'),
    totalBudget: $('#totalBudget'),
    totalClockBox: $('#totalClockBox'),
    btnT0: $('#btnT0'),
    pillMode: $('#pillMode'),
    pillSignal: $('#pillSignal'),
    pillAssemble: $('#pillAssemble'),
    btnPrev: $('#btnPrev'),
    btnNext: $('#btnNext'),
    beats: $('#beats'),
    notes: $('#notes'),
    notesBeat: $('#notesBeat'),
    stagedId: $('#stagedId'),
    btnUnstage: $('#btnUnstage'),
    // tabs
    tabs: $$('.tab'),
    tabPanels: $$('.tab-panel'),
    tabSignalN: $('#tabSignalN'),
    notesIdx: $('#notesIdx'),
    notesTime: $('#notesTime'),
    btnResetBeat: $('#btnResetBeat'),
  };

  // ── Utils ────────────────────────────────────────────────────────
  const pad = (n, w = 3) => String(Math.max(0, n | 0)).padStart(w, '0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const fmtTime = (ts) => {
    const d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => pad(x, 2)).join(':');
  };
  const isKind = (k) => KINDS.includes(k);
  // leading-zero readout: dims the zero prefix
  const readout = (node, n, w = 3) => {
    const s = pad(n, w);
    const m = s.match(/^(0*)(\d*)$/);
    const lz = m[2] === '' ? m[1].slice(0, -1) : m[1];
    const rest = m[2] === '' ? '0' : m[2];
    node.innerHTML = `<span class="lz">${lz}</span>${rest}`;
  };
  const bump = (node) => {
    if (REDUCED_MOTION) return;
    node.classList.remove('is-bump');
    // reflow to restart animation
    void node.offsetWidth;
    node.classList.add('is-bump');
  };
  const status = (msg) => { el.ftrStatus.textContent = msg; };
  const mmss = (ms) => {
    const neg = ms < 0;
    const t = Math.floor(Math.abs(ms) / 1000);
    return `${neg ? '-' : ''}${pad(Math.floor(t / 60), 2)}:${pad(t % 60, 2)}`;
  };

  // ── Header: join URL + clock ─────────────────────────────────────
  function initHeader() {
    const q = new URLSearchParams(location.search);
    const raw = q.get('url') || window.location.origin;
    el.joinUrl.textContent = raw.replace(/^https?:\/\//, '');
    el.joinUrl.title = raw;

    const tick = () => { el.clock.textContent = fmtTime(Date.now()); };
    tick();
    setInterval(tick, 1000);
  }

  // ── Link pill ────────────────────────────────────────────────────
  function setLink(state) {
    S.link = state;
    const pill = el.linkPill;
    pill.classList.remove('pill--live', 'pill--offline', 'pill--linking');
    const map = {
      live:    ['pill--live',    '●', 'LINK ● LIVE'],
      linking: ['pill--linking', '◌', 'LINK ◌ SYNC'],
      offline: ['pill--offline', '○', 'LINK ○ OFFLINE'],
    };
    const [cls, , text] = map[state] || map.offline;
    pill.classList.add(cls);
    $('.pill__text', pill).textContent = text;
  }

  // ── Feed rendering ───────────────────────────────────────────────
  function cardHTML(sub) {
    const kind = isKind(sub.kind) ? sub.kind : 'note';
    const handle = (sub.handle || '').trim();
    const handleHTML = handle
      ? `<span class="card__handle">${esc(handle)}</span>`
      : `<span class="card__handle is-anon">ANON</span>`;
    return `
      <div class="card__meta">
        <span class="card__kind">${kind}</span>
        ${handleHTML}
      </div>
      <button class="card__hide" data-hide="${esc(sub.id)}" title="Hide from feed" aria-label="Hide submission ${esc(sub.id)}">HIDE</button>
      <button class="card__stage" data-stage="${esc(sub.id)}" title="Throw this submission full-screen on the deck" aria-label="Stage submission ${esc(sub.id)} on the deck">STAGE</button>
      <p class="card__text">${esc(sub.text)}</p>
      <div class="card__foot">
        <span class="readout card__ts">${fmtTime(sub.ts)}</span>
        <span class="readout card__id">${esc(sub.id)}</span>
      </div>`;
  }

  function makeCard(sub, entering) {
    const li = document.createElement('li');
    li.className = `card card--${isKind(sub.kind) ? sub.kind : 'note'}`;
    li.dataset.id = sub.id;
    li.dataset.kind = sub.kind;
    li.innerHTML = cardHTML(sub);
    if (S.staged && sub.id === S.staged) li.classList.add('is-staged');
    if (entering && !REDUCED_MOTION) {
      li.classList.add('is-entering');
      li.addEventListener('animationend', () => li.classList.remove('is-entering'), { once: true });
    }
    return li;
  }

  function visible(sub) {
    return S.filter === 'all' || sub.kind === S.filter;
  }

  function renderFeed() {
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const sub of S.submissions) {
      if (!visible(sub)) continue;
      frag.appendChild(makeCard(sub, false));
      if (++n >= MAX_CARDS) break;
    }
    el.cards.replaceChildren(frag);
    updateEmpty();
  }

  function updateEmpty() {
    const any = el.cards.children.length > 0;
    el.feedEmpty.hidden = any;
    if (!any) {
      const hint = $('.empty__hint', el.feedEmpty);
      const label = $('.micro-label', el.feedEmpty);
      if (S.filter === 'all') {
        label.textContent = S.link === 'live' ? 'AWAITING SIGNAL' : 'NO LINK';
        hint.textContent = S.link === 'live'
          ? 'NO TRANSMISSIONS RECEIVED · CHANNEL OPEN'
          : 'FEED UNREACHABLE · RETRYING';
      } else {
        label.textContent = `NO ${S.filter.toUpperCase()} SIGNALS`;
        hint.textContent = 'FILTER ACTIVE · PRESS 1 FOR ALL';
      }
    }
  }

  function prependSubmission(sub) {
    // dedupe (SSE replay / double delivery)
    if (S.submissions.some((s) => s.id === sub.id)) return;
    S.submissions.unshift(sub);
    if (S.submissions.length > 400) S.submissions.length = 400;
    if (isKind(sub.kind)) S.counts[sub.kind] = (S.counts[sub.kind] || 0) + 1;

    if (visible(sub)) {
      el.cards.prepend(makeCard(sub, true));
      while (el.cards.children.length > MAX_CARDS) el.cards.lastElementChild.remove();
    }
    updateEmpty();
    renderCounts();
    bump(el.cSignals);
    status(`RX SIGNAL ${sub.id} · ${fmtTime(sub.ts)}`);
  }

  function removeSubmission(id) {
    const i = S.submissions.findIndex((s) => s.id === id);
    if (i >= 0) {
      const [gone] = S.submissions.splice(i, 1);
      if (isKind(gone.kind)) S.counts[gone.kind] = Math.max(0, (S.counts[gone.kind] || 0) - 1);
    }
    const node = el.cards.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (node) {
      if (REDUCED_MOTION) { node.remove(); updateEmpty(); }
      else {
        node.classList.add('is-leaving');
        node.addEventListener('animationend', () => { node.remove(); updateEmpty(); }, { once: true });
      }
    }
    renderCounts();
  }

  // ── Counters ─────────────────────────────────────────────────────
  function renderCounts() {
    const c = S.counts;
    const signals = (c.question || 0) + (c.discussion || 0) + (c.note || 0);
    readout(el.cSignals, signals);
    readout(el.cAssemblages, c.assemblages || S.assemblages.length);
    $('[data-count="all"]').textContent = pad(signals);
    for (const k of KINDS) $(`[data-count="${k}"]`).textContent = pad(c[k] || 0);
    // badge on the SIGNAL tab so a hidden feed still announces volume
    if (el.tabSignalN) el.tabSignalN.textContent = pad(signals);
  }

  // ── Room shape ───────────────────────────────────────────────────
  // The 1-D histogram + daily-designer→Vader ruler are retired: a single axis
  // measures HOW MUCH and reinstates a destination. renderRoomRadar() draws the
  // MEAN polygon instead. These stubs stay because several callers (state
  // reload, SSE assemblage events, boot) invoke them; they now just forward.
  function initRuler() {
    // nothing to pre-build — the radar renders itself from data
  }

  function renderSpectrum() {
    renderRoomRadar();
  }

  // ── Component tally ──────────────────────────────────────────────
  function labelFor(id) {
    return S.componentLabels[id] || String(id).replace(/[-_]+/g, ' ');
  }

  function renderTally() {
    const entries = Object.entries(S.componentTally || {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8);
    el.tallyEmpty.hidden = entries.length > 0;
    if (!entries.length) { el.tally.replaceChildren(); return; }
    const max = entries[0][1] || 1;
    el.tally.innerHTML = entries.map(([id, n], i) => `
      <li class="tally__row" data-id="${esc(id)}">
        <span class="tally__rank readout">${pad(i + 1, 2)}</span>
        <span class="tally__lbl">
          <span class="tally__name">${esc(labelFor(id))}</span>
          <span class="tally__track"><span class="tally__fill" style="--w:${(n / max) * 100}%"></span></span>
        </span>
        <span class="tally__n readout">${pad(n)}</span>
      </li>`).join('');
  }

  // ── Latest class card (rotating) ─────────────────────────────────
  function recentAssemblages() {
    // newest first, up to 5
    return [...S.assemblages].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 5);
  }

  function renderKlass(animate = false) {
    const list = recentAssemblages();
    const nameEl = $('.klass__name', el.klassBody);
    if (!list.length) {
      nameEl.textContent = 'STANDBY';
      nameEl.classList.add('is-empty');
      el.klassHandle.textContent = '—';
      el.klassPicks.textContent = 'PICKS 00';
      el.klassSpectrum.textContent = 'SPEC 000';
      el.klassIdx.textContent = '— / —';
      return;
    }
    S.klassIdx = S.klassIdx % list.length;
    const a = list[S.klassIdx];
    nameEl.textContent = a.klass || 'UNCLASSED';
    nameEl.classList.remove('is-empty');
    el.klassHandle.textContent = (a.handle || '').trim() || 'ANON';
    el.klassPicks.textContent = `PICKS ${pad(Array.isArray(a.picks) ? a.picks.length : 0, 2)}`;
    el.klassSpectrum.textContent = `SPEC ${pad(Math.round(+a.spectrum || 0))}`;
    el.klassIdx.textContent = `${pad(S.klassIdx + 1, 2)} / ${pad(list.length, 2)}`;
    if (animate && !REDUCED_MOTION) {
      el.klassBody.classList.remove('is-rotating');
      void el.klassBody.offsetWidth;
      el.klassBody.classList.add('is-rotating');
    }
  }

  function startKlassRotation() {
    clearInterval(S.klassTimer);
    S.klassTimer = setInterval(() => {
      const n = recentAssemblages().length;
      if (n < 2) return;
      S.klassIdx = (S.klassIdx + 1) % n;
      renderKlass(true);
    }, KLASS_ROTATE_MS);
  }

  function upsertAssemblage(a) {
    const i = S.assemblages.findIndex((x) => x.sid && x.sid === a.sid);
    const prev = i >= 0 ? S.assemblages[i] : null;
    if (i >= 0) S.assemblages[i] = a; else S.assemblages.push(a);
    S.counts.assemblages = S.assemblages.length;

    // maintain histogram + tally locally (server state is authoritative on reload)
    const bucket = (v) => Math.min(9, Math.max(0, Math.floor((+v || 0) / 10)));
    if (prev) {
      S.spectrumHistogram[bucket(prev.spectrum)] = Math.max(0, (S.spectrumHistogram[bucket(prev.spectrum)] || 0) - 1);
      for (const p of prev.picks || []) S.componentTally[p] = Math.max(0, (S.componentTally[p] || 0) - 1);
    }
    S.spectrumHistogram[bucket(a.spectrum)] = (S.spectrumHistogram[bucket(a.spectrum)] || 0) + 1;
    for (const p of a.picks || []) S.componentTally[p] = (S.componentTally[p] || 0) + 1;

    S.klassIdx = 0;               // jump to the newest
    renderCounts();
    renderSpectrum();
    renderTally();
    renderKlass(true);
    bump(el.cAssemblages);
    status(`RX ASSEMBLAGE ${a.id} · ${a.klass || ''}`.trim());
  }

  // ── Filters ──────────────────────────────────────────────────────
  function setFilter(f) {
    if (f !== 'all' && !isKind(f)) return;
    S.filter = f;
    el.filters.forEach((b) => {
      const on = b.dataset.filter === f;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    renderFeed();
  }

  // ── Moderation ───────────────────────────────────────────────────
  function getAdminKey(force = false) {
    let key = localStorage.getItem(ADMIN_KEY_LS);
    if (!key || force) {
      key = window.prompt('ADMIN KEY');
      if (key == null) return null;
      key = key.trim();
      if (!key) return null;
      localStorage.setItem(ADMIN_KEY_LS, key);
    }
    return key;
  }

  async function hideSubmission(id, btn) {
    const key = getAdminKey();
    if (!key) return;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await fetch(API.moderate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, hidden: true, key }),
      });
      if (res.status === 403) {
        localStorage.removeItem(ADMIN_KEY_LS);
        btn.disabled = false;
        btn.textContent = 'HIDE';
        status('MODERATE 403 · KEY REJECTED · RETRY');
        // one immediate retry with a fresh key
        if (getAdminKey(true)) return hideSubmission(id, btn);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // optimistic: the SSE `moderate` event will also arrive; removeSubmission dedupes
      removeSubmission(id);
      status(`HIDDEN ${id}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'HIDE';
      status(`MODERATE FAILED · ${err.message}`);
    }
  }

  function setModVisible(v) {
    S.modVisible = v;
    el.body.classList.toggle('mod-hidden', !v);
  }

  /* ═════════════════════════════════════════════════════════════════
     CONTROL TRACK — the run of show. This is the thing that advances
     the projector deck: /deck's arrow keys only step slides WITHIN a
     beat; the next BEAT only happens when somebody POSTs /api/cue.
     That somebody is this screen.

     Beats are resolved BY ID, never by array position across the wire.
     Prev/next arithmetic happens locally against the loaded deck and
     the result is always transmitted as an id.
     ═════════════════════════════════════════════════════════════════ */

  function deckSlug() {
    const q = new URLSearchParams(location.search).get('deck');
    const s = (q || DEFAULT_DECK).trim();
    // constrain so ?deck= can't walk the filesystem (same rule as deck.js)
    return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(s) ? s : DEFAULT_DECK;
  }

  async function loadDeck() {
    const slug = deckSlug();
    el.ctrlDeck.textContent = `LOADING ${slug.toUpperCase()}…`;
    try {
      const res = await fetch(`decks/${slug}.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const deck = await res.json();
      if (!deck || !Array.isArray(deck.beats)) throw new Error('deck has no beats[]');
      S.deck = deck;
      S.beats = deck.beats.filter((b) => b && typeof b.id === 'string');
      el.ctrlDeck.textContent =
        `${slug.toUpperCase()} · ${pad(S.beats.length)} BEATS · ${pad(deckTotalMins())}MIN`;
      renderBeats();
      renderNow();
      status(`DECK ${slug.toUpperCase()} · ${pad(S.beats.length)} BEATS`);
      return true;
    } catch (err) {
      S.deck = null;
      S.beats = [];
      el.ctrlDeck.textContent = `DECK UNAVAILABLE`;
      ctrlError(`DECK ${slug.toUpperCase()} FAILED · ${err.message}`);
      renderBeats();
      renderNow();
      return false;
    }
  }

  const deckTotalMins = () => {
    const t = Number(S.deck && S.deck.totalMins);
    if (Number.isFinite(t) && t > 0) return t;
    return S.beats.reduce((a, b) => a + (Number(b.mins) || 0), 0);
  };

  // ── Beat resolution — BY ID, ALWAYS ──────────────────────────────
  const findBeat = (id) => (id ? S.beats.find((b) => b.id === id) || null : null);
  const beatIndex = (id) => S.beats.findIndex((b) => b.id === id);

  /** The beat the UI is *showing* as current: optimistic press wins until
   *  the server's cue lands, so feedback never waits on the network. */
  const shownBeatId = () => S.pendingBeatId || (S.cue && S.cue.beatId) || null;

  // ── FEEDBACK: inline, visible, and it does not go away on its own ──
  let errTimer = null;
  function ctrlError(msg) {
    el.ctrlErr.textContent = msg;
    el.ctrlErr.hidden = false;
    clearTimeout(errTimer);
    errTimer = setTimeout(() => { el.ctrlErr.hidden = true; }, 12000);
  }
  function clearCtrlError() {
    clearTimeout(errTimer);
    el.ctrlErr.hidden = true;
  }
  function fire(btn) {
    if (!btn) return;
    btn.classList.add('is-firing');
    if (REDUCED_MOTION) btn.classList.add('is-reduced');
    setTimeout(() => btn.classList.remove('is-firing'), 220);
  }

  /**
   * Cue a beat by id. Transmits the beat's OWN cue object from the deck
   * JSON verbatim — this screen never synthesises or edits a cue, so it
   * physically cannot flip signalOpen/assembleOpen against Marcel's
   * standing rules. If a deck beat itself would close one, we send it as
   * authored and warn loudly in renderNow().
   */
  async function cueBeat(beatId, btn) {
    const beat = findBeat(beatId);
    if (!beat) { ctrlError(`NO BEAT ${String(beatId).toUpperCase()} IN DECK`); return; }
    const key = getAdminKey();
    if (!key) { ctrlError('CUE ABORTED · NO ADMIN KEY'); return; }

    // 1. FEEDBACK FIRST — inside the same frame as the press.
    fire(btn);
    S.pendingBeatId = beat.id;
    S.beatStartTs = Date.now();
    clearCtrlError();
    renderBeats();
    renderNow();
    renderClocks();
    status(`CUE → ${(beat.label || beat.id).toUpperCase()}`);

    const c = beat.cue || {};
    const body = {
      beatId: beat.id,                        // ID ONLY. never an index.
      label: beat.label || beat.id,
      mode: c.mode,
      prompt: c.prompt || '',
      signalOpen: !!c.signalOpen,
      assembleOpen: !!c.assembleOpen,
      key,
    };

    try {
      const res = await fetch(API.cue, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 403) {
        localStorage.removeItem(ADMIN_KEY_LS);
        S.pendingBeatId = null;
        renderBeats(); renderNow();
        ctrlError('CUE 403 · KEY REJECTED');
        if (getAdminKey(true)) return cueBeat(beatId, btn);
        return;
      }
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j && j.error) detail = j.error; } catch { /* */ }
        throw new Error(detail);
      }
      const json = await res.json();
      // authoritative cue also arrives over SSE; applying here closes the
      // loop even if this presenter's own stream is momentarily down.
      if (json && json.cue) applyCue(json.cue);
      status(`CUE OK · ${beat.id.toUpperCase()}`);
    } catch (err) {
      // WORST CASE: a silent failed cue mid-talk. Never silent.
      S.pendingBeatId = null;
      renderBeats(); renderNow(); renderClocks();
      ctrlError(`CUE FAILED · ${beat.id.toUpperCase()} · ${String(err.message).toUpperCase()}`);
      status(`CUE FAILED · ${err.message}`);
    }
  }

  function stepBeat(delta, btn) {
    if (!S.beats.length) { ctrlError('NO DECK LOADED'); return; }
    const cur = shownBeatId();
    const i = beatIndex(cur);
    // no cue yet (or a beat from another deck): NEXT starts at the top
    const target = i < 0 ? (delta > 0 ? 0 : S.beats.length - 1) : i + delta;
    if (target < 0 || target >= S.beats.length) {
      ctrlError(delta > 0 ? 'END OF DECK · NO NEXT BEAT' : 'START OF DECK · NO PREV BEAT');
      return;
    }
    cueBeat(S.beats[target].id, btn);
  }

  /** Server/SSE cue landed — this is the authority, even if cued from
   *  another device (phone, second laptop, curl). */
  function applyCue(cue) {
    if (!cue || typeof cue !== 'object') return;
    const changed = !S.cue || S.cue.beatId !== cue.beatId;
    S.cue = cue;
    if (S.pendingBeatId && S.pendingBeatId === cue.beatId) S.pendingBeatId = null;
    else if (changed) S.pendingBeatId = null;   // somebody else drove
    if (changed || !S.beatStartTs) {
      // prefer the server's cue timestamp so a reload mid-beat keeps the clock
      S.beatStartTs = Number(cue.ts) || Date.now();
    }
    if (!S.t0 && S.beatStartTs) setT0(S.beatStartTs, false);
    renderBeats();
    renderNow();
    renderClocks();
  }

  // ── Render: beat list ────────────────────────────────────────────
  function renderBeats() {
    if (!S.beats.length) {
      el.beats.innerHTML = `<li class="beat" aria-disabled="true">
        <span class="beat__idx">—</span>
        <span class="beat__lbl">NO DECK</span>
        <span class="beat__mins"></span></li>`;
      return;
    }
    const shown = shownBeatId();
    const curIdx = beatIndex(shown);
    el.beats.innerHTML = S.beats.map((b, i) => {
      const isCur = b.id === shown;
      const pending = isCur && S.pendingBeatId === b.id;
      const cls = ['beat'];
      if (isCur) cls.push('is-current');
      if (pending) cls.push('is-pending');
      if (curIdx >= 0 && i < curIdx) cls.push('is-done');
      const mins = Number(b.mins) || 0;
      return `<li>
        <button class="${cls.join(' ')}" type="button" data-beat="${esc(b.id)}"
                ${isCur ? 'aria-current="true"' : ''}
                title="Cue ${esc(b.label || b.id)}">
          <span class="beat__idx readout">${pad(i + 1)}</span>
          <span class="beat__lbl">${esc(b.label || b.id)}${b.panelOnly ? ' ·P' : ''}</span>
          <span class="beat__mins readout">${pad(mins, 2)}M</span>
        </button></li>`;
    }).join('');
  }

  // ── Render: current beat state / pills / notes ────────────────────
  function renderNow() {
    const cue = S.cue;
    const shown = shownBeatId();
    const beat = findBeat(shown);
    const i = beatIndex(shown);
    const total = S.beats.length;

    el.now.classList.toggle('is-standby', !shown);
    // cued a beat that isn't in this deck: /deck will show NOT IN DECK
    el.now.classList.toggle('is-foreign', !!shown && !beat);

    el.nowIdx.textContent = beat ? `${pad(i + 1)}/${pad(total)}` : (shown ? '···/···' : '—/—');
    el.nowLabel.textContent = beat
      ? String(beat.label || beat.id).toUpperCase()
      : (cue && cue.label ? String(cue.label).toUpperCase() : 'STANDBY');

    const mode = (cue && cue.mode) || (beat && beat.cue && beat.cue.mode) || '—';
    el.pillMode.textContent = `MODE ${String(mode).toUpperCase()}`;
    setOpenPill(el.pillSignal, 'SIGNAL', !!(cue && cue.signalOpen));
    setOpenPill(el.pillAssemble, 'ASSEMBLE', !!(cue && cue.assembleOpen));

    const prompt = (cue && cue.prompt) || (beat && beat.cue && beat.cue.prompt) || '';
    el.nowPrompt.textContent = prompt || '—';

    // WARN, don't rewrite: Marcel's standing rules are SIGNAL opens once and
    // never closes, ASSEMBLE stays editable. If the deck itself authored a
    // regression we transmit it as written and say so here.
    const warns = [];
    if (!beat && shown) warns.push(`BEAT ${String(shown).toUpperCase()} NOT IN THIS DECK · /DECK WILL HOLD`);
    if (beat) {
      const i2 = i;
      const everSignal = S.beats.slice(0, i2).some((b) => b.cue && b.cue.signalOpen);
      const everAssemble = S.beats.slice(0, i2).some((b) => b.cue && b.cue.assembleOpen);
      const c = beat.cue || {};
      if (everSignal && !c.signalOpen && c.mode !== 'closed') warns.push('DECK CLOSES SIGNAL · RULE SAYS IT NEVER CLOSES');
      if (everAssemble && !c.assembleOpen && c.mode !== 'closed') warns.push('DECK CLOSES ASSEMBLE · RULE SAYS IT STAYS EDITABLE');
    }
    el.nowWarn.textContent = warns.join(' // ');
    el.nowWarn.hidden = warns.length === 0;

    // CONSTRAINT: dead ends are visibly unavailable
    el.btnPrev.disabled = !S.beats.length || i === 0;
    el.btnNext.disabled = !S.beats.length || (i >= 0 && i === total - 1);

    renderNotes(beat);
  }

  function setOpenPill(pill, label, open) {
    pill.classList.toggle('is-open', open);
    pill.classList.toggle('is-shut', !open);
    $('.pill__text', pill).textContent = `${label} ${open ? 'OPEN' : 'SHUT'}`;
  }

  function renderNotes(beat) {
    el.notesBeat.textContent = beat ? String(beat.label || beat.id).toUpperCase() : '—';
    const text = beat && typeof beat.presenterNotes === 'string' ? beat.presenterNotes.trim() : '';
    if (!text) {
      el.notes.innerHTML = `<p class="notes__empty micro-label">${
        beat ? 'NO NOTES FOR THIS BEAT' : 'NO BEAT CUED · PRESS NEXT BEAT'}</p>`;
      return;
    }
    el.notes.innerHTML = text.split(/\n{2,}/).map((p) => `<p>${esc(p.trim())}</p>`).join('');
    el.notes.scrollTop = 0;
  }

  // ── Clocks: this beat vs its budget, talk vs totalMins ───────────
  function setT0(ts, persist = true) {
    S.t0 = ts;
    if (persist) { try { localStorage.setItem(T0_LS, String(ts)); } catch { /* */ } }
  }

  function gradeBox(box, elapsedMs, budgetMs) {
    const over = budgetMs > 0 && elapsedMs > budgetMs;
    box.classList.toggle('is-warn', over && elapsedMs <= budgetMs * OVER_HARD);
    box.classList.toggle('is-over', over && elapsedMs > budgetMs * OVER_HARD);
  }

  function renderClocks() {
    const now = Date.now();
    const beat = findBeat(shownBeatId());
    const budget = (Number(beat && beat.mins) || 0) * 60000;
    const elapsed = S.beatStartTs ? now - S.beatStartTs : 0;
    el.beatElapsed.textContent = S.beatStartTs ? mmss(elapsed) : '--:--';
    el.beatBudget.textContent = `/ ${budget ? mmss(budget) : '--:--'}`;
    gradeBox(el.beatClockBox, S.beatStartTs ? elapsed : 0, budget);

    const tBudget = deckTotalMins() * 60000;
    const tElapsed = S.t0 ? now - S.t0 : 0;
    el.totalElapsed.textContent = S.t0 ? mmss(tElapsed) : '--:--';
    el.totalBudget.textContent = `/ ${tBudget ? mmss(tBudget) : '--:--'}`;
    gradeBox(el.totalClockBox, S.t0 ? tElapsed : 0, tBudget);

    // mirror onto the NOTES tab header so the script surface is self-sufficient
    if (el.notesTime) {
      el.notesTime.textContent = `${S.beatStartTs ? mmss(elapsed) : '--:--'} / ${budget ? mmss(budget) : '--:--'}`;
      el.notesTime.classList.toggle('is-warn', budget > 0 && elapsed > budget && elapsed <= budget * OVER_HARD);
      el.notesTime.classList.toggle('is-over', budget > 0 && elapsed > budget * OVER_HARD);
    }
    if (el.notesIdx) {
      const i = S.beats.findIndex((b) => b.id === shownBeatId());
      el.notesIdx.textContent = i >= 0 ? `${pad(i + 1, 2)}/${pad(S.beats.length, 2)}` : '—/—';
    }
  }

  // ── STAGE: throw a submission full-screen on the deck ────────────
  async function stageSubmission(id, btn) {
    const key = getAdminKey();
    if (!key) { ctrlError('STAGE ABORTED · NO ADMIN KEY'); return; }
    fire(btn);
    if (btn) btn.disabled = true;
    // optimistic mark, reverted if the POST fails
    const prev = S.staged;
    setStaged(id === null ? null : id);
    status(id === null ? 'UNSTAGE →' : `STAGE → ${id}`);
    try {
      const res = await fetch(API.stage, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id === null ? null : id, key }),
      });
      if (res.status === 403) {
        localStorage.removeItem(ADMIN_KEY_LS);
        setStaged(prev);
        if (btn) btn.disabled = false;
        ctrlError('STAGE 403 · KEY REJECTED');
        if (getAdminKey(true)) return stageSubmission(id, btn);
        return;
      }
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j && j.error) detail = j.error; } catch { /* */ }
        throw new Error(detail);
      }
      const json = await res.json();
      setStaged(json && 'staged' in json ? json.staged : id);
      if (btn) btn.disabled = false;
      clearCtrlError();
      status(id === null ? 'UNSTAGED' : `STAGED ${id}`);
    } catch (err) {
      setStaged(prev);
      if (btn) btn.disabled = false;
      ctrlError(`STAGE FAILED · ${String(err.message).toUpperCase()}`);
      status(`STAGE FAILED · ${err.message}`);
    }
  }

  function setStaged(id) {
    S.staged = id || null;
    el.stagedId.textContent = S.staged || 'NONE';
    el.btnUnstage.hidden = !S.staged;
    document.querySelector('.staged-bar').classList.toggle('is-live', !!S.staged);
    for (const li of el.cards.children) {
      const on = !!S.staged && li.dataset.id === S.staged;
      li.classList.toggle('is-staged', on);
      const b = li.querySelector('[data-stage]');
      if (b) b.textContent = on ? 'STAGED' : 'STAGE';
    }
  }

  // ── Session label in the header ──────────────────────────────────
  function renderSession() {
    const s = S.session || { n: 1, label: 'SESSION 001' };
    const raw = String(s.label || 'SESSION 001').toUpperCase();
    const n = Number(s.n);
    el.hdrSession.textContent = /^SESSION\b/.test(raw)
      ? raw
      : `SESSION ${pad(Number.isFinite(n) ? n : 1)} · ${raw}`;
  }

  // ── Tabs ─────────────────────────────────────────────────────────
  const TAB_LS = 'cyborg.tab';
  // NOTES is no longer a tab — it lives permanently in the control panel
  // alongside the run of show. Only two surfaces cycle now.
  const TAB_ORDER = ['control', 'signal'];

  function setTab(name) {
    if (!TAB_ORDER.includes(name)) return;
    S.tab = name;
    try { localStorage.setItem(TAB_LS, name); } catch { /* */ }
    el.tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    el.tabPanels.forEach((p) => {
      p.classList.toggle('is-active', p.dataset.panel === name);
    });
    status(`TAB · ${name.toUpperCase()}`);
  }

  function cycleTab(dir = 1) {
    const i = TAB_ORDER.indexOf(S.tab);
    setTab(TAB_ORDER[(i + dir + TAB_ORDER.length) % TAB_ORDER.length]);
  }

  function initTabs() {
    let stored = 'control';
    try { stored = localStorage.getItem(TAB_LS) || 'control'; } catch { /* */ }
    el.tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
    setTab(TAB_ORDER.includes(stored) ? stored : 'control');
  }

  function initControlTrack() {
    const stored = Number(localStorage.getItem(T0_LS));
    if (Number.isFinite(stored) && stored > 0) S.t0 = stored;

    el.btnNext.addEventListener('click', () => stepBeat(+1, el.btnNext));
    el.btnPrev.addEventListener('click', () => stepBeat(-1, el.btnPrev));
    el.btnT0.addEventListener('click', () => {
      setT0(Date.now());
      renderClocks();
      fire(el.btnT0);
      status('TOTAL CLOCK ZEROED');
    });
    el.btnResetBeat.addEventListener('click', () => {
      S.beatStartTs = Date.now();
      renderClocks();
      fire(el.btnResetBeat);
      status('BEAT CLOCK ZEROED');
    });
    el.btnUnstage.addEventListener('click', () => stageSubmission(null, el.btnUnstage));
    el.beats.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-beat]');
      if (!btn) return;
      cueBeat(btn.dataset.beat, btn);
    });

    renderBeats();
    renderNow();
    renderClocks();
    renderSession();
    setStaged(null);
    clearInterval(S.clockTimer);
    S.clockTimer = setInterval(renderClocks, 1000);
  }

  // ── Data: /api/state ─────────────────────────────────────────────
  async function loadState() {
    setLink('linking');
    status('GET /api/state');
    try {
      const res = await fetch(API.state, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const st = await res.json();
      applyState(st);
      status(`STATE OK · ${S.submissions.length} SIGNALS · ${S.assemblages.length} ASSEMBLAGES`);
      return true;
    } catch (err) {
      status(`STATE UNAVAILABLE · ${err.message}`);
      setLink('offline');
      updateEmpty();
      return false;
    }
  }

  function applyState(st) {
    const subs = Array.isArray(st.submissions) ? st.submissions : [];
    // contract: newest last -> we keep newest first, hidden excluded
    S.submissions = subs.filter((s) => s && !s.hidden).slice().reverse();
    S.assemblages = Array.isArray(st.assemblages) ? st.assemblages.slice() : [];
    const c = st.counts || {};
    S.counts = {
      question: c.question ?? S.submissions.filter((s) => s.kind === 'question').length,
      discussion: c.discussion ?? S.submissions.filter((s) => s.kind === 'discussion').length,
      note: c.note ?? S.submissions.filter((s) => s.kind === 'note').length,
      assemblages: c.assemblages ?? S.assemblages.length,
    };
    S.spectrumHistogram = Array.isArray(st.spectrumHistogram) && st.spectrumHistogram.length === 10
      ? st.spectrumHistogram.slice()
      : new Array(10).fill(0);
    S.componentTally = st.componentTally && typeof st.componentTally === 'object' ? { ...st.componentTally } : {};
    S.klassIdx = 0;
    if (st.session) { S.session = st.session; renderSession(); }
    renderFeed();
    renderCounts();
    renderSpectrum();
    renderTally();
    renderKlass(false);
    // control track: server is authoritative for both cue and staged
    if ('staged' in st) setStaged(st.staged || null);
    if (st.cue) applyCue(st.cue);
    else { renderBeats(); renderNow(); renderClocks(); }
  }

  // Component labels for the tally, plus the axes/ghosts the room radar needs.
  // components.v2.json is the live catalog (7-axis vectors); v1 components.json
  // is the retired 1-D weight catalog and must not be read.
  async function loadComponentLabels() {
    try {
      const res = await fetch('components.v2.json', { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      const list = Array.isArray(json) ? json : (json.components || []);
      for (const c of list) if (c && c.id) S.componentLabels[c.id] = c.label || c.id;
      S.axes = json.axes || [];
      // FIXED spoke order from the data file — never sorted by value.
      S.axisOrder = (json.aggregation && json.aggregation.axisOrder)
        || S.axes.map(a => a.id);
      // ghost.room is the live aggregate; the presenter draws that from real
      // assemblages, so only authored references are used as ghosts.
      S.ghosts = (json.ghosts || []).filter(g => g.id !== 'ghost.room');
      renderTally();
      renderRoomRadar();
    } catch { /* optional */ }
  }

  // Room polygon = MEAN of the participant vectors. Mean, not sum: a fuller
  // room must not inflate the shape, or the projector shows a scoreboard.
  // Participant COUNT is reported as text, never as radius.
  function renderRoomRadar() {
    if (!el.roomRadar || !window.Radar || !(S.axisOrder || []).length) return;
    const vectors = S.assemblages.map(a => a && a.vector).filter(Boolean);
    const room = window.Radar.meanOfVectors(vectors, S.axisOrder);
    window.Radar.mount(el.roomRadar, {
      vector: room,
      axes: S.axes || [],
      axisOrder: S.axisOrder,
      ghosts: S.ghosts || [],
      pickCount: vectors.length,
      size: 300,
      labels: true,
    });
    if (el.roomRadarMeta) {
      el.roomRadarMeta.textContent = vectors.length
        ? `N=${pad(vectors.length)} · MEAN`
        : 'N=000 · IDLE';
    }
  }

  // ── Data: SSE /api/feed with backoff ─────────────────────────────
  function connectFeed() {
    if (S.es) { S.es.close(); S.es = null; }
    clearTimeout(S.reconnectTimer);
    setLink('linking');

    let es;
    try {
      es = new EventSource(API.feed);
    } catch (err) {
      scheduleReconnect();
      return;
    }
    S.es = es;

    es.addEventListener('open', async () => {
      // we may have missed events while disconnected: resync state
      const ok = await loadState();
      S.backoff = BACKOFF.base;
      setLink(ok ? 'live' : 'linking');
      updateEmpty();
    });

    es.addEventListener('submission', (e) => {
      try {
        const sub = JSON.parse(e.data);
        if (sub && !sub.hidden) prependSubmission(sub);
      } catch { /* ignore malformed */ }
    });

    es.addEventListener('assemblage', (e) => {
      try { upsertAssemblage(JSON.parse(e.data)); } catch { /* ignore */ }
    });

    es.addEventListener('moderate', (e) => {
      try {
        const m = JSON.parse(e.data);
        if (!m || !m.id) return;
        if (m.hidden && S.staged === m.id) setStaged(null);
        if (m.hidden) removeSubmission(m.id);
        else loadState();     // un-hide: simplest correct path is a resync
      } catch { /* ignore */ }
    });

    // THE cue event — keeps this presenter correct even when the room was
    // cued from another device. Beat is resolved by id.
    es.addEventListener('cue', (e) => {
      try { applyCue(JSON.parse(e.data)); } catch { /* ignore */ }
    });

    es.addEventListener('staged', (e) => {
      try {
        const d = JSON.parse(e.data);
        setStaged(d && d.staged ? d.staged : null);
      } catch { /* ignore */ }
    });

    // new session: logs archived, cue back to default. Full resync.
    es.addEventListener('reset', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d && d.session) { S.session = d.session; renderSession(); }
      } catch { /* ignore */ }
      S.pendingBeatId = null;
      S.beatStartTs = 0;
      setStaged(null);
      setT0(Date.now());
      status('RESET · NEW SESSION');
      loadState();
    });

    es.addEventListener('ping', () => { if (S.link !== 'live') setLink('live'); });

    es.addEventListener('error', () => {
      // EventSource auto-retries on transient drops, but on hard failures
      // (404 / connection refused) readyState goes CLOSED — we own the backoff.
      setLink('offline');
      updateEmpty();
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        S.es = null;
        scheduleReconnect();
      }
    });
  }

  function scheduleReconnect() {
    clearTimeout(S.reconnectTimer);
    const wait = S.backoff;
    S.backoff = Math.min(BACKOFF.max, Math.round(S.backoff * 1.8));
    status(`LINK DOWN · RETRY IN ${pad(Math.round(wait / 1000), 2)}s`);
    S.reconnectTimer = setTimeout(connectFeed, wait);
  }

  // ── Keyboard ─────────────────────────────────────────────────────
  function initKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      switch (e.key) {
        // ── TAB switching. Tab / Shift+Tab cycles the three surfaces.
        case 'Tab':
          e.preventDefault();
          cycleTab(e.shiftKey ? -1 : +1);
          break;
        // ── BEAT transport. Deliberately NOT ArrowRight/ArrowLeft/PageUp/
        // PageDown: a presenter clicker sends those and /deck consumes them
        // for slides. Down/Up (and n/p) are beats, and only on this screen.
        case 'ArrowDown': case 'n': case 'N':
          e.preventDefault();
          stepBeat(+1, el.btnNext);
          break;
        case 'ArrowUp': case 'p': case 'P':
          e.preventDefault();
          stepBeat(-1, el.btnPrev);
          break;
        case 'f': case 'F':
          e.preventDefault();
          if (document.fullscreenElement) document.exitFullscreen?.();
          else document.documentElement.requestFullscreen?.().catch(() => {});
          break;
        case '1': setFilter('all'); break;
        case '2': setFilter('question'); break;
        case '3': setFilter('discussion'); break;
        case '4': setFilter('note'); break;
        case 'h': case 'H': setModVisible(!S.modVisible); break;
        // ── CLOCKS: r zeroes this beat, t zeroes the whole talk.
        case 'r': case 'R':
          e.preventDefault();
          S.beatStartTs = Date.now();
          renderClocks();
          fire(el.btnResetBeat);
          status('BEAT CLOCK ZEROED');
          break;
        case 't': case 'T':
          e.preventDefault();
          setT0(Date.now());
          renderClocks();
          fire(el.btnT0);
          status('TOTAL CLOCK ZEROED');
          break;
        case 'l': case 'L': loadState(); break;
        default: return;
      }
    });
  }

  // ── Pointer: hide cursor when idle (clean projection) ────────────
  function initCursor() {
    let t;
    const show = () => {
      el.body.classList.add('show-cursor');
      clearTimeout(t);
      t = setTimeout(() => el.body.classList.remove('show-cursor'), 2500);
    };
    document.addEventListener('mousemove', show, { passive: true });
  }

  // ── Events ───────────────────────────────────────────────────────
  function initEvents() {
    el.filters.forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
    el.cards.addEventListener('click', (e) => {
      const stageBtn = e.target.closest('[data-stage]');
      if (stageBtn) {
        const id = stageBtn.dataset.stage;
        // toggle: pressing STAGE on the already-staged card clears the deck
        stageSubmission(S.staged === id ? null : id, stageBtn);
        return;
      }
      const btn = e.target.closest('[data-hide]');
      if (!btn) return;
      hideSubmission(btn.dataset.hide, btn);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !S.es) connectFeed();
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────
  function boot() {
    initHeader();
    initRuler();
    initKeys();
    initCursor();
    initEvents();
    initControlTrack();
    initTabs();
    setLink('offline');
    renderCounts();
    renderSpectrum();
    renderTally();
    renderKlass(false);
    updateEmpty();
    startKlassRotation();
    loadComponentLabels();
    loadDeck();
    // loadState runs inside the SSE 'open' handler so we never miss events
    // between state fetch and stream attach; if SSE never opens we still
    // try state once so a static-served presenter shows whatever it can.
    connectFeed();
    loadState();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // tiny debug hook for the operator console
  window.CYBORG_PRESENTER = {
    state: S, setFilter, reload: loadState, reconnect: connectFeed,
    // control track — exposed for the operator console / smoke tests
    cueBeat, stepBeat, stageSubmission, loadDeck, findBeat,
  };
})();
