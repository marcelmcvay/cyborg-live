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
    slide: 'api/slide',
    stage: 'api/stage',
    promptPin: 'api/prompt-pin',
  };
  const ADMIN_KEY_LS = 'cyborg.adminKey';
  const T0_LS = 'cyborg.t0';          // ms epoch of "talk starts now"
  const DEFAULT_DECK = 'design-week-ri';
  const MAX_CARDS = 60;               // DOM cap; feed is newest-first
  const KINDS = ['question', 'discussion', 'note'];
  // Story-builder slots (see CONTRACT.md COLLECTIVE TAB section). Marcel
  // pins the winner per slot from this screen; rpg.js resolves
  // pinned > highest-voted > latest > built-in default.
  const PROMPT_SLOTS = ['SETTING', 'COMPANION', 'THREAT', 'ARTIFACT', 'TWIST'];
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
    collapsed: new Set(),   // telemetry module keys collapsed by the operator
    slideIdx: 0,            // slide the PROJECTOR is showing (authoritative)
    pendingSlideIdx: null,  // optimistic local position while the POST is in flight
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
    // ── story pin panel ──
    promptPieces: { SETTING: [], COMPANION: [], THREAT: [], ARTIFACT: [], TWIST: [] },
    promptPins: { SETTING: null, COMPANION: null, THREAT: null, ARTIFACT: null, TWIST: null },
    pinPending: {}, // slot -> id currently in flight (optimistic), or undefined
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

    notesSlide: $('#notesSlide'),
    roomRadar: $('#roomRadar'),
    roomRadarMeta: $('#roomRadarMeta'),
    radarProxy: $('#radarProxy'),
    tallyProxy: $('#tallyProxy'),
    klassProxy: $('#klassProxy'),

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
    // story pin panel — injected into the DOM by injectPinPanel(), see below
    pinPanel: null,
    pinRows: null,
    pinProxy: null,
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
    // proxy for the collapsed state: top component + its count, so a hidden
    // tally still tells the operator what the room is converging on
    if (el.tallyProxy) {
      el.tallyProxy.textContent = entries.length
        ? `${labelFor(entries[0][0]).slice(0, 14).toUpperCase()} ${pad(entries[0][1])}`
        : '000';
    }
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
      if (el.klassProxy) el.klassProxy.textContent = '—';
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
    // collapsed proxy: the class name alone is the useful glance
    if (el.klassProxy) el.klassProxy.textContent = (a.klass || 'UNCLASSED').toUpperCase().slice(0, 18);
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
      collectiveOpen: !!c.collectiveOpen,
      ...(c.collectiveFocus ? { collectiveFocus: c.collectiveFocus } : {}),
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
      // A beat cue always lands on slide 0 without a slide POST, so a room
      // change authored on slide 0 (slide.cue) would never fire. Send it now.
      const s0 = Array.isArray(beat.slides) && beat.slides[0];
      if (s0 && s0.cue) {
        const r2 = await fetch(API.slide, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ beatId: beat.id, slide: 0, key, slideCue: s0.cue }),
        });
        if (!r2.ok) ctrlError(`SLIDE-1 ROOM CHANGE FAILED · HTTP ${r2.status}`);
      }
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
    // Slide position rides on the cue. A beat change always lands on slide 0;
    // a reload mid-beat picks up wherever the room actually is.
    if (changed) {
      S.slideIdx = Number.isInteger(cue.slide) ? cue.slide : 0;
      S.pendingSlideIdx = null;
    } else if (Number.isInteger(cue.slide) && S.pendingSlideIdx == null) {
      S.slideIdx = cue.slide;
    }
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

  // Notes are rendered as one block PER SLIDE in the beat. The block matching
  // the slide currently on the projector is marked `is-live`, and clicking any
  // block sends the projector to that slide — so this screen is the only
  // interface the operator touches. Slide position is authoritative from the
  // server (`cue.slide`, POST /api/slide, SSE `slide`).
  //
  //   1. slide.note      — authored per slide (preferred; see DECK-SCHEMA.md)
  //   2. presenterNotes  — beat-level prose, shown as a BEAT block
  function slideCaption(slide) {
    if (!slide || typeof slide !== 'object') return '';
    // the words actually on the projector, so the operator can match at a glance
    const raw = slide.text || slide.title
      || (Array.isArray(slide.items) ? slide.items.join(' · ') : '')
      || (Array.isArray(slide.beats) ? slide.beats.join(' · ') : '');
    if (raw) return String(raw);
    // live slides carry no authored text — name what they will show instead
    if (slide.kind === 'histogram') return 'live dependence histogram';
    if (slide.kind === 'radar') return 'live room radar';
    if (slide.kind === 'staged') return 'staged audience card';
    return '';
  }

  function renderNotes(beat) {
    el.notesBeat.textContent = beat ? String(beat.label || beat.id).toUpperCase() : '—';
    if (!beat) {
      el.notes.innerHTML = '<p class="notes__empty micro-label">NO BEAT CUED · PRESS NEXT BEAT</p>';
      return;
    }

    const slides = Array.isArray(beat.slides) ? beat.slides : [];
    const beatText = typeof beat.presenterNotes === 'string' ? beat.presenterNotes.trim() : '';
    const blocks = [];
    if (el.notesSlide) {
      el.notesSlide.textContent = slides.length
        ? `SLIDE ${pad(shownSlideIdx() + 1, 2)}/${pad(slides.length, 2)}`
        : 'SLIDE —/—';
    }

    // Beat-level prose first: this is the throughline for the whole beat.
    if (beatText) {
      blocks.push(`
        <section class="nb nb--beat">
          <header class="nb__head">
            <span class="nb__tag micro-label">BEAT</span>
            <span class="nb__cap">${esc(String(beat.label || beat.id).toUpperCase())}</span>
          </header>
          <div class="nb__body">${
            beatText.split(/\n{2,}/).map((para) => `<p>${esc(para.trim())}</p>`).join('')
          }</div>
        </section>`);
    }

    // One block per slide, numbered to match the projector's step order.
    // Buttons, not sections: clicking one drives the projector to that slide.
    const live = shownSlideIdx();
    slides.forEach((slide, i) => {
      const note = typeof slide.note === 'string' ? slide.note.trim() : '';
      const cap = slideCaption(slide);
      const isLive = i === live;
      blocks.push(`
        <button type="button" class="nb nb--slide${note ? '' : ' is-bare'}${isLive ? ' is-live' : ''}"
                data-slide="${i}" aria-current="${isLive ? 'true' : 'false'}">
          <span class="nb__head">
            <span class="nb__n readout">${pad(i + 1, 2)}</span>
            <span class="nb__tag micro-label">${esc(String(slide.kind || '').toUpperCase())}</span>
            ${cap ? `<span class="nb__cap">${esc(cap)}</span>` : ''}
            ${isLive ? '<span class="nb__live micro-label">ON SCREEN</span>' : ''}
          </span>
          ${note
            ? `<span class="nb__body">${note.split(/\n{2,}/).map((para) => `<span class="nb__p">${esc(para.trim())}</span>`).join('')}</span>`
            : ''}
        </button>`);
    });

    if (!blocks.length) {
      el.notes.innerHTML = '<p class="notes__empty micro-label">NO NOTES FOR THIS BEAT</p>';
      return;
    }

    el.notes.innerHTML = blocks.join('');
    // Keep the live block in view when the projector moves — the operator
    // should never have to hunt for their place after a slide change.
    const liveEl = $(`[data-slide="${live}"]`, el.notes);
    if (liveEl && typeof liveEl.scrollIntoView === 'function') {
      liveEl.scrollIntoView({ block: 'nearest', behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
    }
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

  // ── Collapsible telemetry modules ────────────────────────────────
  // The right column scrolls, but on a 720p lectern screen four expanded
  // modules still means scrolling to reach the radar. Collapsing is how the
  // operator pins what matters for the current beat. State persists so a
  // mid-talk reload comes back configured the way it was.
  const COLLAPSE_LS = 'cyborg.collapsed';

  function loadCollapsed() {
    try {
      const raw = localStorage.getItem(COLLAPSE_LS);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
    } catch { return new Set(); }
  }

  function saveCollapsed() {
    try { localStorage.setItem(COLLAPSE_LS, JSON.stringify([...S.collapsed])); } catch { /* */ }
  }

  function applyCollapsed() {
    $$('[data-module]').forEach((panel) => {
      const key = panel.dataset.module;
      const btn = $('[data-collapse]', panel);
      if (!btn) return; // counters have no toggle — always visible
      const off = S.collapsed.has(key);
      panel.classList.toggle('is-collapsed', off);
      btn.setAttribute('aria-expanded', String(!off));
    });
  }

  function toggleModule(key) {
    if (S.collapsed.has(key)) S.collapsed.delete(key); else S.collapsed.add(key);
    saveCollapsed();
    applyCollapsed();
    // a freshly-expanded radar has zero size until it is re-rendered
    if (key === 'radar' && !S.collapsed.has('radar')) renderRoomRadar();
    status(`${key.toUpperCase()} · ${S.collapsed.has(key) ? 'COLLAPSED' : 'EXPANDED'}`);
  }

  function initCollapse() {
    S.collapsed = loadCollapsed();
    $$('[data-collapse]').forEach((btn) => {
      btn.addEventListener('click', () => toggleModule(btn.dataset.collapse));
    });
    applyCollapsed();
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
    // Clicking a notes block drives the projector to that slide. Delegated,
    // because renderNotes() replaces the whole subtree on every update.
    el.notes.addEventListener('click', (e) => {
      const blk = e.target.closest('[data-slide]');
      if (!blk) return;
      cueSlide(Number(blk.dataset.slide));
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
    // story pin panel: promptPieces carry live vote counts on every /api/state
    // call per contract, so this refresh alone keeps vote counts current even
    // without the promptvote SSE event landing.
    applyPromptState(st);
  }

  /* ═════════════════════════════════════════════════════════════════
     STORY PIN PANEL — Marcel stewards which audience-submitted phrase
     wins each of the 5 narrative slots feeding the terminal RPG (rpg.js).
     See CONTRACT.md COLLECTIVE TAB section: POST /api/prompt-pin, and
     GET /api/state's promptPieces/promptCounts/promptVotes/promptPins.

     Same admin-key-gated POST pattern as cueBeat/stageSubmission/
     hideSubmission above: body { key, slot, id }, id=null clears the pin.
     Optimistic UI update on click, reconciled against the authoritative
     `promptpin` SSE event so the two paths never fight — applyPromptPin()
     is the single place both converge on.
     ═════════════════════════════════════════════════════════════════ */

  function applyPromptState(st) {
    if (st && st.promptPieces && typeof st.promptPieces === 'object') {
      PROMPT_SLOTS.forEach((slot) => {
        const arr = st.promptPieces[slot];
        S.promptPieces[slot] = Array.isArray(arr) ? arr.slice() : [];
      });
    }
    if (st && st.promptPins && typeof st.promptPins === 'object') {
      PROMPT_SLOTS.forEach((slot) => {
        S.promptPins[slot] = st.promptPins[slot] || null;
        // an authoritative pin state supersedes any stale optimistic guess
        if (S.pinPending[slot] !== undefined && S.pinPending[slot] === S.promptPins[slot]) {
          delete S.pinPending[slot];
        }
      });
    }
    renderPinPanel();
    // style ideas ride the same /api/state payload
    if (st && Array.isArray(st.styleIdeas)) {
      S.styleIdeas = st.styleIdeas.slice(-40);
      renderStylePanel();
    }
  }

  /* ═════════════════════════════════════════════════════════════════
     STYLE IDEAS PANEL — the room's restyle pitches for the Space Sandbox
     apps. Marcel reads, picks one, COPY puts it on the clipboard as a
     ready-to-paste prompt for Claude Code on the laptop. No server write:
     picking is a stage act, the room sees the result on the projector.
     ═════════════════════════════════════════════════════════════════ */
  S.styleIdeas = [];
  S.stylePicked = null;

  function injectStylePanel() {
    const tele = $('.tele');
    if (!tele) return;
    const section = document.createElement('section');
    section.className = 'fui-panel stylepanel';
    section.id = 'stylePanel';
    section.dataset.module = 'style';
    section.setAttribute('aria-label', 'Room restyle ideas');
    section.innerHTML = `
      <span class="fui-corners" aria-hidden="true"></span>
      <div class="panel__head panel__head--tight">
        <button class="panel__toggle" type="button" data-collapse="style" aria-expanded="true" aria-controls="styleBody">
          <span class="panel__caret" aria-hidden="true"></span>
          <span class="panel__title">
            <span class="micro-label">SPACE SANDBOX</span>
            <span class="panel__h" role="heading" aria-level="2">RESTYLE IDEAS</span>
          </span>
          <span class="panel__proxy readout" id="styleProxy">000</span>
        </button>
      </div>
      <div class="panel__collapse" id="styleBody">
        <ol class="stylerows" id="styleRows"></ol>
      </div>`;
    // sit above the pin panel: restyle happens first in the running order
    const pin = $('#pinPanel', tele);
    tele.insertBefore(section, pin || null);
    el.styleRows = $('#styleRows', section);
    el.styleProxy = $('#styleProxy', section);
    el.styleRows.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy]');
      if (!btn) return;
      copyStyleIdea(btn.dataset.copy, btn);
    });
  }

  function renderStylePanel() {
    if (!el.styleRows) return;
    if (el.styleProxy) el.styleProxy.textContent = pad(S.styleIdeas.length, 3);
    if (!S.styleIdeas.length) {
      el.styleRows.innerHTML = '<li class="stylerow__empty micro-label">NOTHING YET · CUE THE RESTYLE SLIDE TO OPEN IT ON PHONES</li>';
      return;
    }
    el.styleRows.innerHTML = S.styleIdeas.slice().reverse().map((s) => `
      <li class="stylerow${S.stylePicked === s.id ? ' is-picked' : ''}">
        <span class="stylerow__txt">${esc(s.text)}</span>
        <span class="stylerow__who micro-label">${esc(s.handle || 'ANON')}</span>
        <button type="button" class="pinbtn${S.stylePicked === s.id ? ' is-active' : ''}" data-copy="${esc(s.id)}"
                title="Copy as a restyle prompt for Claude Code">${S.stylePicked === s.id ? 'COPIED' : 'COPY'}</button>
      </li>`).join('');
  }

  async function copyStyleIdea(id, btn) {
    const idea = S.styleIdeas.find((s) => s.id === id);
    if (!idea) return;
    fire(btn);
    const prompt = `Restyle this app's visual design based on this idea from the audience: "${idea.text}". ` +
      'Only change the CSS custom properties in the :root block (colors, fonts, radii). Keep the layout, content, and behavior exactly as they are. Show me the diff.';
    try {
      await navigator.clipboard.writeText(prompt);
      S.stylePicked = id;
      renderStylePanel();
      status('RESTYLE PROMPT COPIED · PASTE INTO CLAUDE CODE');
    } catch {
      // clipboard needs a secure, focused page; fall back to a selectable prompt
      window.prompt('Copy this restyle prompt:', prompt);
    }
  }

  function onStyleIdea(idea) {
    if (!idea || !idea.id || S.styleIdeas.some((s) => s.id === idea.id)) return;
    S.styleIdeas.push(idea);
    S.styleIdeas = S.styleIdeas.slice(-40);
    renderStylePanel();
  }

  function onPromptPieceFrame(piece) {
    if (!piece || !piece.id || !PROMPT_SLOTS.includes(piece.slot)) return;
    const arr = S.promptPieces[piece.slot] || (S.promptPieces[piece.slot] = []);
    if (arr.some((p) => p.id === piece.id)) return;
    arr.push({ votes: 0, ...piece });
    renderPinPanel();
  }

  function pinnedIdFor(slot) {
    return slot in S.pinPending ? S.pinPending[slot] : S.promptPins[slot];
  }

  function injectPinPanel() {
    const tele = $('.tele');
    if (!tele) return;
    const section = document.createElement('section');
    section.className = 'fui-panel pinpanel';
    section.id = 'pinPanel';
    section.dataset.module = 'pin';
    section.setAttribute('aria-label', 'Story slot pins');
    section.innerHTML = `
      <span class="fui-corners" aria-hidden="true"></span>
      <div class="panel__head panel__head--tight">
        <button class="panel__toggle" type="button" data-collapse="pin" aria-expanded="true" aria-controls="pinBody">
          <span class="panel__caret" aria-hidden="true"></span>
          <span class="panel__title">
            <span class="micro-label">STORY BUILDER</span>
            <span class="panel__h" role="heading" aria-level="2">SLOT PINS</span>
          </span>
          <span class="panel__proxy readout" id="pinProxy">—</span>
        </button>
      </div>
      <div class="panel__collapse" id="pinBody">
        <div class="gameprompt">
          <button type="button" class="pinbtn gameprompt__btn" id="gamePromptBtn"
                  title="Copy a build prompt for a capable model: the room's winning blanks + an 80s-90s studio agent team">COPY GAME PROMPT</button>
          <span class="gameprompt__hint micro-label" id="gamePromptHint">PINNED &gt; VOTED &gt; LATEST · TOP 3 PER BLANK</span>
        </div>
        <ol class="pinrows" id="pinRows"></ol>
      </div>`;
    tele.appendChild(section);
    el.pinPanel = section;
    el.pinRows = $('#pinRows', section);
    el.pinProxy = $('#pinProxy', section);
    el.gamePromptBtn = $('#gamePromptBtn', section);
    el.gamePromptHint = $('#gamePromptHint', section);
    el.gamePromptBtn.addEventListener('click', () => copyGamePrompt(el.gamePromptBtn));

    // NOTE: the [data-collapse] button is wired generically by initCollapse()
    // (it queries the whole document), same as every other telemetry module —
    // do not add a second listener here or the toggle would fire twice.

    el.pinRows.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pin]');
      if (!btn) return;
      const slot = btn.dataset.pinSlot;
      const id = btn.dataset.pin === '__clear__' ? null : btn.dataset.pin;
      pinSlot(slot, id, btn);
    });
  }

  function pinRowHTML(slot) {
    const pieces = (S.promptPieces[slot] || []).slice()
      .sort((a, b) => (b.votes || 0) - (a.votes || 0) || (b.ts || 0) - (a.ts || 0));
    const pinnedId = pinnedIdFor(slot);
    const pending = slot in S.pinPending;
    const candidates = pieces.length
      ? pieces.map((p) => {
          const isPinned = pinnedId && p.id === pinnedId;
          return `
            <li class="pinrow__cand${isPinned ? ' is-pinned' : ''}">
              <span class="pinrow__check" aria-hidden="true">${isPinned ? '✓' : ''}</span>
              <span class="pinrow__txt">${esc(p.text)}</span>
              <span class="pinrow__votes readout">${pad(p.votes || 0, 2)}</span>
              <button type="button" class="pinbtn${isPinned ? ' is-active' : ''}"
                      data-pin="${esc(p.id)}" data-pin-slot="${esc(slot)}"
                      ${pending ? 'disabled' : ''}
                      title="Pin this phrase as ${esc(slot)}">${isPinned ? 'PINNED' : 'PIN'}</button>
            </li>`;
        }).join('')
      : `<li class="pinrow__empty micro-label">NO SUBMISSIONS YET</li>`;
    return `
      <li class="pinrow" data-slot="${esc(slot)}">
        <div class="pinrow__head">
          <span class="pinrow__slot micro-label">${esc(slot)}</span>
          <button type="button" class="pinbtn pinbtn--clear" data-pin="__clear__" data-pin-slot="${esc(slot)}"
                  ${pinnedId ? '' : 'disabled'} ${pending ? 'disabled' : ''}
                  title="Clear pin for ${esc(slot)} (falls back to highest-voted / latest / default)">CLEAR</button>
        </div>
        <ul class="pinrow__list">${candidates}</ul>
      </li>`;
  }

  /* ═════════════════════════════════════════════════════════════════
     GAME PROMPT — turns the room's blanks into a build prompt Marcel pastes
     into a capable model OUTSIDE the talk. Winner per slot resolves exactly
     like rpg.js (pinned > most voted > latest); runners-up ride along as
     flavor. Appends a small 80s-90s game-studio agent team to execute it.
     Client-side only: nothing is sent anywhere, it just hits the clipboard.
     ═════════════════════════════════════════════════════════════════ */
  const SLOT_ROLE = {
    SETTING: 'Where the game takes place',
    COMPANION: 'Who travels with the player',
    THREAT: "What's hunting the player",
    ARTIFACT: 'The object that matters',
    TWIST: 'The rule that breaks the world',
  };

  function slotRanking(slot) {
    const pieces = (S.promptPieces[slot] || []).slice();
    if (!pieces.length) return { winner: null, how: 'none', rest: [] };
    const pinId = pinnedIdFor(slot);
    const pinned = pinId && pieces.find((p) => p.id === pinId);
    const byVotes = pieces.slice().sort((a, b) => (b.votes || 0) - (a.votes || 0) || (b.ts || 0) - (a.ts || 0));
    const newest = pieces.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
    const winner = pinned || ((byVotes[0].votes || 0) > 0 ? byVotes[0] : newest);
    const how = pinned ? 'pinned by the presenter' : (winner.votes || 0) > 0 ? `${winner.votes} vote${winner.votes === 1 ? '' : 's'}` : 'latest submission';
    const rest = byVotes.filter((p) => p.id !== winner.id).slice(0, 2);
    return { winner, how, rest };
  }

  function buildGamePrompt() {
    const lines = [];
    const filled = PROMPT_SLOTS.filter((s) => (S.promptPieces[s] || []).length);
    const deckTitle = (S.deck && S.deck.title) || 'a live lecture';
    lines.push(
      '# BUILD THE ROOM\'S GAME',
      '',
      `A lecture audience ("${deckTitle}") co-wrote this game live on their phones, one blank at a time, then voted. ` +
      'Your job is to build it as a finished, playable browser game. Treat their words as the creative brief: ' +
      'interpret them literally and with wit, never sand them down into something generic.',
      '',
      '## THE ROOM\'S BLANKS (winner first, runners-up are optional flavor)',
    );
    PROMPT_SLOTS.forEach((slot) => {
      const { winner, how, rest } = slotRanking(slot);
      lines.push('', `${slot} — ${SLOT_ROLE[slot]}`);
      if (!winner) { lines.push('  WINNER: (the room left this blank; the studio invents one that fits the others)'); return; }
      lines.push(`  WINNER: "${winner.text}"  [${how}${winner.handle ? `, from ${winner.handle}` : ''}]`);
      rest.forEach((p) => lines.push(`  also:   "${p.text}"  [${p.votes || 0} vote${(p.votes || 0) === 1 ? '' : 's'}]`));
    });
    lines.push(
      '',
      '## THE STUDIO',
      'Run this as a small game studio circa 1987-1995 (think Sierra, LucasArts, Infocom, early id): tight team, hard constraints, ' +
      'strong authorship, ship on a floppy. Work as five agents with clear ownership. If you can spawn subagents, give each role its own; ' +
      'if not, work through the roles in order and label each hand-off.',
      '',
      '1. CREATIVE DIRECTOR — owns the vision. Writes a one-page design doc first: premise, tone, the core loop, a win and a lose state. ' +
      'Every blank above must be load-bearing in the design, not set dressing. Makes the final call on every dispute. Protects the weird.',
      '2. DESIGNER / WRITER — owns rooms, puzzles and words. 5-8 locations, at least one puzzle that uses the ARTIFACT, the COMPANION ' +
      'with a voice and opinions, the THREAT with escalating pressure, and the TWIST changing how the player reads everything before it. ' +
      'Parser verbs or point-and-click, whichever serves the idea. Every line of text earns its space.',
      '3. PIXEL / ASCII ARTIST — owns every visual. Period-true: EGA or VGA palette, or pure ASCII/ANSI art in a 16-colour terminal. ' +
      'A title screen, a drawing for every location, and a portrait for the COMPANION and the THREAT. Readable from the back of a room.',
      '4. PROGRAMMER — owns the build. One self-contained index.html: vanilla JS, no frameworks, no build step, no network requests, ' +
      'runs by double-clicking. Keyboard-first, works on a phone too. Save/restore to localStorage. Chiptune-style sound via Web Audio, ' +
      'muted until the player turns it on.',
      '5. QA / PLAYTESTER — owns nothing and checks everything. Plays start to finish, tries to break the parser, softlock the puzzles ' +
      'and skip the TWIST. Files bugs back to the owning role. Nothing ships until QA can finish the game and lose it.',
      '',
      '## PROCESS',
      '- Director\'s design doc before any code. Then build a vertical slice (title, one room, one interaction) and playtest it before the rest.',
      '- Keep a short studio log: each hand-off, each QA bug, each call the Director made.',
      '',
      '## DELIVER',
      '- index.html (the whole game), the one-page design doc, the studio log.',
      '- A 3-line "how to play" and the credits screen naming the audience as co-writers.',
    );
    return { text: lines.join('\n'), filled: filled.length };
  }

  async function copyGamePrompt(btn) {
    const { text, filled } = buildGamePrompt();
    fire(btn);
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'COPIED';
      btn.classList.add('is-active');
      status(`GAME PROMPT COPIED · ${filled}/${PROMPT_SLOTS.length} BLANKS FROM THE ROOM`);
      setTimeout(() => { btn.textContent = 'COPY GAME PROMPT'; btn.classList.remove('is-active'); }, 2500);
    } catch {
      window.prompt('Copy this game prompt:', text);
    }
  }

  function renderPinPanel() {
    if (!el.pinRows) return;
    el.pinRows.innerHTML = PROMPT_SLOTS.map(pinRowHTML).join('');
    if (el.pinProxy) {
      const pinnedCount = PROMPT_SLOTS.filter((s) => pinnedIdFor(s)).length;
      el.pinProxy.textContent = `${pad(pinnedCount, 1)}/${PROMPT_SLOTS.length} PINNED`;
    }
  }

  async function pinSlot(slot, id, btn) {
    if (!PROMPT_SLOTS.includes(slot)) return;
    const key = getAdminKey();
    if (!key) { ctrlError('PIN ABORTED · NO ADMIN KEY'); return; }

    // 1. FEEDBACK FIRST — optimistic update in the same frame as the press.
    fire(btn);
    const prevPending = S.pinPending[slot];
    const hadPending = slot in S.pinPending;
    S.pinPending[slot] = id;
    clearCtrlError();
    renderPinPanel();
    status(id === null ? `PIN CLEAR → ${slot}` : `PIN → ${slot}`);

    try {
      const res = await fetch(API.promptPin, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, slot, id }),
      });
      if (res.status === 403) {
        localStorage.removeItem(ADMIN_KEY_LS);
        if (hadPending) S.pinPending[slot] = prevPending; else delete S.pinPending[slot];
        renderPinPanel();
        ctrlError('PIN 403 · KEY REJECTED');
        if (getAdminKey(true)) return pinSlot(slot, id, btn);
        return;
      }
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j && j.error) detail = j.error; } catch { /* */ }
        throw new Error(detail);
      }
      const json = await res.json();
      // authoritative pin also arrives over SSE (`promptpin`); applying here
      // closes the loop even if this presenter's own stream is momentarily
      // down, and applyPromptPin() is idempotent against the SSE echo.
      applyPromptPin(json && json.slot ? json.slot : slot, json && 'pinnedId' in json ? json.pinnedId : id);
      status(id === null ? `PIN CLEARED · ${slot}` : `PINNED · ${slot}`);
    } catch (err) {
      if (hadPending) S.pinPending[slot] = prevPending; else delete S.pinPending[slot];
      renderPinPanel();
      ctrlError(`PIN FAILED · ${slot} · ${String(err.message).toUpperCase()}`);
      status(`PIN FAILED · ${err.message}`);
    }
  }

  // Single point of truth for a landed pin, whether it arrived as this
  // screen's own POST response or as the `promptpin` SSE event (possibly
  // from another window / device). Idempotent: applying the same value
  // twice is a no-op past the first render.
  function applyPromptPin(slot, pinnedId) {
    if (!PROMPT_SLOTS.includes(slot)) return;
    S.promptPins[slot] = pinnedId || null;
    if (S.pinPending[slot] !== undefined) delete S.pinPending[slot];
    renderPinPanel();
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
    // collapsed proxy: participant count, so a hidden radar still declares
    // whether the room is actually feeding it
    if (el.radarProxy) el.radarProxy.textContent = `N=${pad(vectors.length)}`;
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

    // Story pin panel live updates — see CONTRACT.md COLLECTIVE TAB.
    // promptvote keeps vote counts current between /api/state polls (which
    // already refresh votes on every call, so this is a nice-to-have for
    // snappier feedback, not the only path); promptpin reconciles a pin
    // made from ANOTHER window/device against this one.
    es.addEventListener('promptvote', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (!d || !d.id) return;
        for (const slot of PROMPT_SLOTS) {
          const arr = S.promptPieces[slot];
          if (!Array.isArray(arr)) continue;
          const piece = arr.find((p) => p.id === d.id);
          if (piece) { piece.votes = d.votes; renderPinPanel(); break; }
        }
      } catch { /* ignore malformed frame */ }
    });

    es.addEventListener('promptpin', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (!d || !d.slot) return;
        applyPromptPin(d.slot, d.pinnedId);
      } catch { /* ignore malformed frame */ }
    });

    es.addEventListener('styleidea', (e) => {
      try { onStyleIdea(JSON.parse(e.data)); } catch { /* ignore malformed frame */ }
    });

    es.addEventListener('promptpiece', (e) => {
      try { onPromptPieceFrame(JSON.parse(e.data)); } catch { /* ignore malformed frame */ }
    });

    // Slide moved — by this presenter, another presenter, or a clicker on the
    // deck machine. Ignore frames for a beat we are not on.
    es.addEventListener('slide', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.beatId && d.beatId !== shownBeatId()) return;
        if (!Number.isInteger(d.slide)) return;
        S.slideIdx = d.slide;
        S.pendingSlideIdx = null;
        if (S.cue) S.cue = { ...S.cue, slide: d.slide };
        renderNotes(findBeat(shownBeatId()));
        renderNow();
      } catch { /* ignore */ }
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
  // ── SLIDE transport ─────────────────────────────────────────────
  // The presenter owns which slide the projector shows, so the operator never
  // has to move between two interfaces. Clicking a notes block, or pressing
  // Right/Left, POSTs /api/slide and the deck follows over SSE.
  //
  // Optimistic: the highlight moves in the same frame as the press and only
  // rolls back if the POST fails. A lectern control that waits on a round trip
  // feels broken even when it is working.
  function shownSlideIdx() {
    return S.pendingSlideIdx == null ? S.slideIdx : S.pendingSlideIdx;
  }

  function slideCountOf(beat) {
    return Array.isArray(beat && beat.slides) ? beat.slides.length : 0;
  }

  async function cueSlide(n) {
    const beat = findBeat(shownBeatId());
    if (!beat) { ctrlError('NO BEAT CUED · CANNOT SET SLIDE'); return; }
    const count = slideCountOf(beat);
    if (!count) return;
    const next = Math.min(count - 1, Math.max(0, Number(n) || 0));
    if (next === shownSlideIdx()) return;

    const key = getAdminKey();
    if (!key) { ctrlError('SLIDE ABORTED · NO ADMIN KEY'); return; }

    // 1. FEEDBACK FIRST — same frame as the press.
    const prev = S.slideIdx;
    S.pendingSlideIdx = next;
    clearCtrlError();
    renderNotes(beat);
    status(`SLIDE → ${pad(next + 1, 2)}/${pad(count, 2)}`);

    try {
      const res = await fetch(API.slide, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          beatId: beat.id, slide: next, key,
          // a slide may carry its own room change (e.g. open COLLECTIVE mid-beat);
          // sent verbatim from the deck JSON, never synthesised here
          ...(beat.slides[next] && beat.slides[next].cue ? { slideCue: beat.slides[next].cue } : {}),
        }),
      });
      if (res.status === 403) {
        localStorage.removeItem(ADMIN_KEY_LS);
        S.pendingSlideIdx = null;
        renderNotes(beat);
        ctrlError('SLIDE 403 · KEY REJECTED');
        if (getAdminKey(true)) return cueSlide(next);
        return;
      }
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j && j.error) detail = j.error; } catch { /* */ }
        throw new Error(detail);
      }
      const json = await res.json();
      S.slideIdx = Number.isInteger(json && json.slide) ? json.slide : next;
      S.pendingSlideIdx = null;
      renderNotes(beat);
    } catch (err) {
      // Roll back to what the room is actually showing — never leave the
      // highlight claiming a slide the projector never received.
      S.slideIdx = prev;
      S.pendingSlideIdx = null;
      renderNotes(beat);
      ctrlError(`SLIDE FAILED · ${String(err.message).toUpperCase()}`);
      status(`SLIDE FAILED · ${err.message}`);
    }
  }

  function stepSlide(delta) {
    cueSlide(shownSlideIdx() + delta);
  }

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
        // ── SLIDE transport. ArrowRight/Left + PageDown/Up, which is exactly
        // what a presenter clicker sends: plug the clicker into THIS machine
        // and it drives the projector's slides through the server.
        case 'ArrowRight': case 'PageDown': case ' ': case 'Spacebar':
          e.preventDefault();
          stepSlide(+1);
          break;
        case 'ArrowLeft': case 'PageUp': case 'Backspace':
          e.preventDefault();
          stepSlide(-1);
          break;
        // ── BEAT transport on Down/Up (and n/p) so beats and slides never
        // fight over the same key. Beats are the coarse move, slides the fine.
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
    initCollapse();
    injectPinPanel();
    injectStylePanel();
    renderStylePanel();
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
