/* ═══════════════════════════════════════════════════════════════════
   CYBORG // LIVE — deck.js
   The projector screen. Pure listener: it never POSTs, never mutates
   room state. Marcel drives it from /presenter via POST /api/cue.

   Data path:  GET ./api/state  ->  EventSource ./api/feed
   Deck path:  ./decks/<slug>.json   (?deck=slug, default design-week-ri)

   ALL paths are relative so the app survives being served under a
   reverse-proxy prefix like /cyborg/.

   Beats are ALWAYS resolved by id, never by array index (DECK-SCHEMA.md).
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────
  const API = { state: 'api/state', feed: 'api/feed' };
  const DEFAULT_DECK = 'design-week-ri';
  const BACKOFF = { base: 1000, max: 30000 };
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The histogram now plots DEPENDENCE — "what breaks if it stops" — which is
  // the one derived scalar retained from the retired daily-designer→Vader
  // spectrum. Those old labels implied a destination and a ranking; these
  // describe a real axis end to end. Vader lives on as a ghost polygon on the
  // radar, a comparison rather than an endpoint.
  const SPECTRUM_LABELS = [
    { n: 0, t: 'INCONVENIENCE' },
    { n: 25, t: 'DISRUPTION' },
    { n: 50, t: 'CANT WORK' },
    { n: 75, t: 'CANT FUNCTION' },
    { n: 100, t: 'DEATH' },
  ];

  // ── State ────────────────────────────────────────────────────────
  const S = {
    deck: null,               // parsed deck JSON
    beats: [],                // deck.beats
    beatId: null,             // currently rendered beat id
    beatIdx: -1,              // its position (display only — never a lookup key)
    slideIdx: 0,
    cue: null,
    session: { label: 'SESSION 001' },
    submissions: [],
    stagedId: null,
    stagedSub: null,
    spectrumHistogram: new Array(10).fill(0),
    assemblages: [],
    axes: [],               // radar axis metadata (components.v2.json)
    axisOrder: [],           // FIXED spoke order — never sort by value
    ghosts: [],              // authored reference polygons
    es: null,
    link: 'offline',
    backoff: BACKOFF.base,
    reconnectTimer: null,
  };

  // ── DOM ──────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = {
    body: document.body,
    stage: $('#stage'),
    boot: $('#bootSlide'),
    bootMsg: $('#bootMsg'),
    linkPill: $('#linkPill'),
    sessionLabel: $('#sessionLabel'),
    beatLabel: $('#beatLabel'),
    beatReadout: $('#beatReadout'),
    slideReadout: $('#slideReadout'),
  };

  // ── Utils ────────────────────────────────────────────────────────
  const pad = (n, w = 3) => String(Math.max(0, n | 0)).padStart(w, '0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  // dim the leading zeros in a readout (003/007)
  const lz = (n, w = 3) => {
    const s = pad(n, w);
    const m = s.match(/^(0*)(\d*)$/);
    const zeros = m[2] === '' ? m[1].slice(0, -1) : m[1];
    const rest = m[2] === '' ? '0' : m[2];
    return `<span class="lz">${zeros}</span>${rest}`;
  };
  const boot = (msg) => { el.bootMsg.textContent = msg; };

  // ── Link pill ────────────────────────────────────────────────────
  function setLink(next) {
    S.link = next;
    const p = el.linkPill;
    p.classList.remove('is-live', 'is-warn', 'is-danger', 'is-pulsing');
    const map = {
      live: ['is-live', 'LINK ● LIVE'],
      linking: ['is-warn is-pulsing', 'LINK ◌ SYNC'],
      offline: ['is-danger', 'LINK ○ OFFLINE'],
    };
    const [cls, text] = map[next] || map.offline;
    cls.split(' ').forEach((c) => p.classList.add(c));
    $('.pill__text', p).textContent = text;
  }

  // ── Deck loading ─────────────────────────────────────────────────
  function deckSlug() {
    const q = new URLSearchParams(location.search).get('deck');
    const s = (q || DEFAULT_DECK).trim();
    // constrain to a safe slug so ?deck= can't walk the filesystem
    return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(s) ? s : DEFAULT_DECK;
  }

  async function loadDeck() {
    const slug = deckSlug();
    boot(`LOADING DECK ${slug.toUpperCase()}…`);
    try {
      const res = await fetch(`decks/${slug}.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const deck = await res.json();
      if (!deck || !Array.isArray(deck.beats)) throw new Error('deck has no beats[]');
      S.deck = deck;
      S.beats = deck.beats.filter((b) => b && typeof b.id === 'string');
      boot(`DECK ${slug.toUpperCase()} · ${pad(S.beats.length)} BEATS · AWAITING CUE`);
      renderStrip();
      // if a cue already arrived (state raced the deck fetch), honour it now
      if (S.cue && S.cue.beatId) applyCue(S.cue, true);
      return true;
    } catch (err) {
      boot(`DECK ${slug.toUpperCase()} UNAVAILABLE · ${String(err.message).toUpperCase()}`);
      return false;
    }
  }

  // ── Beat resolution — BY ID, ALWAYS ──────────────────────────────
  function findBeat(id) {
    if (!id) return null;
    return S.beats.find((b) => b.id === id) || null;
  }

  /**
   * Apply a cue. If the beatId isn't in this deck (e.g. a panelOnly beat
   * cued while the lecture deck is loaded) we keep whatever is on screen —
   * the projector must never blank or throw mid-talk.
   */
  function applyCue(cue, force = false) {
    S.cue = cue;
    if (!cue || !cue.beatId) return;
    if (!S.beats.length) return;             // deck not loaded yet; loadDeck replays
    const beat = findBeat(cue.beatId);
    if (!beat) {
      // graceful degradation: hold the previous slide, note it in the strip
      el.beatLabel.textContent = `${(cue.label || cue.mode || '').toUpperCase()} · NOT IN DECK`;
      el.beatLabel.classList.add('is-orphan');
      return;
    }
    el.beatLabel.classList.remove('is-orphan');
    if (!force && beat.id === S.beatId) { renderStrip(); return; }
    S.beatId = beat.id;
    S.beatIdx = S.beats.indexOf(beat);
    S.slideIdx = 0;                          // cue change always jumps to slide 0
    renderBeat(true);
  }

  // ── Slide navigation (clicker: Arrow keys, Space fallback) ───────
  function slidesOf(beat) {
    const arr = Array.isArray(beat && beat.slides) ? beat.slides.filter(Boolean) : [];
    return arr.length ? arr : [{ kind: 'statement', text: beat && beat.label ? beat.label : '' }];
  }

  function step(delta) {
    const beat = findBeat(S.beatId);
    if (!beat) return;
    const n = slidesOf(beat).length;
    const next = Math.min(n - 1, Math.max(0, S.slideIdx + delta));
    if (next === S.slideIdx) return;
    S.slideIdx = next;
    renderBeat(true);
  }

  // ── Slide renderers ──────────────────────────────────────────────
  const RENDER = {
    statement(s) {
      return `<span class="statement__mark" aria-hidden="true"></span>
              <h2 class="statement">${esc(s.text)}</h2>`;
    },

    quote(s) {
      return `<blockquote class="quote">
                <p class="quote__text">${esc(s.text)}</p>
                <span class="quote__rule" aria-hidden="true"></span>
                <cite class="quote__attrib">${esc(s.attrib || '')}</cite>
              </blockquote>`;
    },

    spectrum(s) {
      const labels = Array.isArray(s.labels) && s.labels.length === 5
        ? s.labels.map((t, i) => ({ n: SPECTRUM_LABELS[i].n, t: String(t) }))
        : SPECTRUM_LABELS;
      let ticks = '';
      for (let i = 0; i <= 20; i++) ticks += `<i class="${i % 5 === 0 ? 'major' : ''}"></i>`;
      return `<div class="spectrum">
                ${s.title ? `<h2 class="spectrum__title">${esc(s.title)}</h2>` : ''}
                <div class="ruler">
                  <div class="ruler__ticks">${ticks}</div>
                  <div class="ruler__line"></div>
                  <div class="ruler__labels">
                    ${labels.map((l) => `<span><span class="n">${pad(l.n, 3)}</span>${esc(l.t)}</span>`).join('')}
                  </div>
                </div>
              </div>`;
    },

    histogram() {
      let bars = '';
      for (let i = 0; i < 10; i++) {
        bars += `<div class="histbar" data-b="${i}">
                   <span class="histbar__n">0</span>
                   <span class="histbar__fill" style="--h:0%"></span>
                 </div>`;
      }
      let ticks = '';
      for (let i = 0; i <= 20; i++) ticks += `<i class="${i % 5 === 0 ? 'major' : ''}"></i>`;
      return `<div class="spectrum" data-live="histogram">
                <div class="hist">${bars}</div>
                <div class="hist__base"></div>
                <div class="ruler">
                  <div class="ruler__labels">
                    ${SPECTRUM_LABELS.map((l) => `<span><span class="n">${pad(l.n, 3)}</span>${esc(l.t)}</span>`).join('')}
                  </div>
                </div>
                <div class="hist__meta">
                  <span>N <b class="js-n">000</b></span>
                  <span>MEAN <b class="js-mean">—</b></span>
                  <span>MODE <b class="js-mode">—</b></span>
                </div>
              </div>`;
    },

    // Room radar. The money shot for the reveal beat: the room's MEAN polygon
    // with authored ghosts behind it. data-live marks it for repaint on every
    // incoming assemblage.
    radar(s) {
      return `<div class="deck-radar" data-live="radar">
                ${s.title ? `<h2 class="spectrum__title">${esc(s.title)}</h2>` : ''}
                <div class="deck-radar__host" id="deckRadarHost"></div>
                <div class="hist__meta">
                  <span>N <b class="js-n">000</b></span>
                  <span>AGGREGATION <b>MEAN</b></span>
                </div>
              </div>`;
    },

    list(s) {
      const items = (Array.isArray(s.items) ? s.items : []).slice(0, 4);
      return `<ul class="list">
                ${items.map((it, i) => `
                  <li>
                    <span class="tick" aria-hidden="true"></span>
                    <span class="idx">${pad(i + 1, 2)}</span>
                    <span class="txt">${esc(it)}</span>
                  </li>`).join('')}
              </ul>`;
    },

    caseStudy(s) {
      const beats = Array.isArray(s.beats) ? s.beats : [];
      return `<div class="case">
                <h2 class="case__title">${esc(s.title || '')}</h2>
                <div class="case__beats">
                  ${beats.map((b, i) => `
                    <p class="case__beat"><span class="n">${pad(i + 1, 2)}</span><span>${esc(b)}</span></p>
                  `).join('')}
                </div>
              </div>`;
    },

    staged() {
      return `<div class="staged" data-live="staged">
                <div class="js-staged-body">
                  <p class="staged__empty">NO SUBMISSION STAGED</p>
                </div>
              </div>`;
    },

    prompt(s) {
      const url = joinUrl();
      return `<div class="prompt">
                <h2 class="prompt__q">${esc(s.text)}</h2>
                <div class="prompt__join">
                  <span class="prompt__joinLabel">JOIN</span>
                  <span class="prompt__url">${esc(url)}</span>
                </div>
              </div>`;
    },
  };

  function joinUrl() {
    const q = new URLSearchParams(location.search).get('url');
    if (q) return q.replace(/^https?:\/\//, '');
    // relative-safe: strip deck.html / /deck off the current path
    const base = location.origin + location.pathname.replace(/(deck\.html|\/deck\/?)$/, '');
    return base.replace(/^https?:\/\//, '').replace(/\/$/, '') || location.host;
  }

  function renderBeat(animate) {
    const beat = findBeat(S.beatId);
    if (!beat) return;
    const slides = slidesOf(beat);
    S.slideIdx = Math.min(S.slideIdx, slides.length - 1);
    const slide = slides[S.slideIdx];
    const kind = RENDER[slide.kind] ? slide.kind : 'statement';
    const live = kind === 'histogram' || kind === 'staged' || kind === 'radar';

    const sec = document.createElement('section');
    sec.className = `slide slide--${kind} is-current`;
    sec.dataset.kind = kind;
    sec.innerHTML =
      `<span class="micro-label slide__kind${live ? ' is-live' : ''}">${live ? 'LIVE · ' : ''}${esc(beat.label || kind).toUpperCase()}</span>` +
      RENDER[kind](slide);
    if (animate && !REDUCED_MOTION) {
      sec.classList.add('is-entering');
      sec.addEventListener('animationend', () => sec.classList.remove('is-entering'), { once: true });
    }
    el.stage.replaceChildren(sec);

    if (kind === 'histogram') paintHistogram();
    if (kind === 'radar') paintRadar();
    if (kind === 'staged') paintStaged();
    renderStrip();
  }

  // ── Live paints (called on render AND on SSE events) ─────────────
  function paintHistogram() {
    const root = $('[data-live="histogram"]', el.stage);
    if (!root) return;
    const h = (Array.isArray(S.spectrumHistogram) && S.spectrumHistogram.length === 10)
      ? S.spectrumHistogram.map((x) => x | 0) : new Array(10).fill(0);
    const max = Math.max(1, ...h);
    const total = h.reduce((a, b) => a + b, 0);
    let modeIdx = -1;
    h.forEach((n, i) => {
      const bar = root.querySelector(`.histbar[data-b="${i}"]`);
      if (!bar) return;
      bar.querySelector('.histbar__fill').style.setProperty('--h', `${(n / max) * 100}%`);
      bar.querySelector('.histbar__n').textContent = String(n);
      const isMax = n > 0 && n === max;
      bar.classList.toggle('is-max', isMax);
      if (isMax && modeIdx < 0) modeIdx = i;
    });
    let mean = null;
    if (S.assemblages.length) {
      mean = S.assemblages.reduce((a, x) => a + (+x.spectrum || 0), 0) / S.assemblages.length;
    } else if (total) {
      mean = h.reduce((a, n, i) => a + n * (i * 10 + 5), 0) / total;
    }
    root.querySelector('.js-n').textContent = pad(total);
    root.querySelector('.js-mean').textContent = mean == null ? '—' : pad(Math.round(mean));
    root.querySelector('.js-mode').textContent = modeIdx < 0 ? '—' : `${pad(modeIdx * 10, 3)}–${pad(modeIdx * 10 + 10, 3)}`;

    // light up the nearest ruler label to the modal bucket
    const near = modeIdx < 0 ? -1 : Math.round(((modeIdx * 10 + 5) / 100) * 4);
    [...root.querySelectorAll('.ruler__labels span')].forEach((s, i) => s.classList.toggle('is-mode', i === near));
  }

  // Room polygon on the projector. MEAN of participant vectors — a fuller room
  // must not grow the shape. N is reported as text; radius never encodes count.
  function paintRadar() {
    const root = $('[data-live="radar"]', el.stage);
    if (!root) return;
    const host = root.querySelector('.deck-radar__host');
    const vectors = S.assemblages.map((a) => a && a.vector).filter(Boolean);
    const n = root.querySelector('.js-n');
    if (n) n.textContent = pad(vectors.length);
    if (!host || !window.Radar || !(S.axisOrder || []).length) return;
    window.Radar.mount(host, {
      vector: window.Radar.meanOfVectors(vectors, S.axisOrder),
      axes: S.axes || [],
      axisOrder: S.axisOrder,
      ghosts: S.ghosts || [],
      pickCount: vectors.length,
      size: 560,
      labels: true,
    });
  }

  function paintStaged() {
    const root = $('[data-live="staged"] .js-staged-body', el.stage);
    if (!root) return;
    const sub = S.stagedSub || S.submissions.find((s) => s.id === S.stagedId) || null;
    if (!sub) {
      root.innerHTML = `<p class="staged__empty">NO SUBMISSION STAGED</p>`;
      return;
    }
    const long = String(sub.text || '').length > 120;
    root.innerHTML = `
      <p class="staged__text${long ? ' is-long' : ''}">${esc(sub.text)}</p>
      <span class="staged__rule" aria-hidden="true"></span>
      <div class="staged__meta">
        <span class="handle">${esc((sub.handle || '').trim() || 'ANON')}</span>
        <span>${esc(String(sub.kind || 'note').toUpperCase())}</span>
        <span class="id">${esc(sub.id)}</span>
      </div>`;
  }

  function repaintLive() {
    if (!el.stage.firstElementChild) return;
    const kind = el.stage.firstElementChild.dataset.kind;
    if (kind === 'histogram') paintHistogram();
    if (kind === 'radar') paintRadar();
    if (kind === 'staged') paintStaged();
  }

  // ── Status strip ─────────────────────────────────────────────────
  function renderStrip() {
    // spec format: "SESSION 002 · DESIGN WEEK RI". The server's session.label is
    // already the room name ("DESIGN WEEK RI") after a /api/reset rename, or the
    // literal default "SESSION 001" — handle both without doubling up.
    const raw = String(S.session.label || 'SESSION 001').toUpperCase();
    const n = Number(S.session.n);
    el.sessionLabel.textContent = /^SESSION\b/.test(raw)
      ? raw
      : `SESSION ${pad(Number.isFinite(n) ? n : 1)} · ${raw}`;

    const beat = findBeat(S.beatId);
    if (beat && !el.beatLabel.classList.contains('is-orphan')) {
      el.beatLabel.textContent = (beat.label || beat.id).toUpperCase();
    }
    const total = S.beats.length;
    const idx = S.beatIdx >= 0 ? S.beatIdx + 1 : 0;
    el.beatReadout.innerHTML = `${lz(idx)}/${pad(total)}`;

    const slides = beat ? slidesOf(beat).length : 1;
    el.slideReadout.textContent = `${pad(S.slideIdx + 1, 2)}/${pad(slides, 2)}`;
  }

  // ── Data: GET ./api/state ────────────────────────────────────────
  function applyState(st) {
    if (!st || typeof st !== 'object') return;
    S.submissions = Array.isArray(st.submissions) ? st.submissions.filter((s) => s && !s.hidden) : [];
    S.assemblages = Array.isArray(st.assemblages) ? st.assemblages.slice() : [];
    S.spectrumHistogram = (Array.isArray(st.spectrumHistogram) && st.spectrumHistogram.length === 10)
      ? st.spectrumHistogram.slice() : new Array(10).fill(0);
    if (st.session && st.session.label) S.session = st.session;
    if ('staged' in st) {
      S.stagedId = st.staged || null;
      S.stagedSub = S.stagedId ? S.submissions.find((s) => s.id === S.stagedId) || null : null;
    }
    if (st.cue) applyCue(st.cue, S.beatId === null);
    renderStrip();
    repaintLive();
  }

  async function loadState() {
    try {
      const res = await fetch(API.state, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyState(await res.json());
      return true;
    } catch (err) {
      if (!S.beatId) boot(`STATE UNAVAILABLE · ${String(err.message).toUpperCase()}`);
      return false;
    }
  }

  // ── Data: SSE ./api/feed, with our own backoff ───────────────────
  function connectFeed() {
    if (S.es) { S.es.close(); S.es = null; }
    clearTimeout(S.reconnectTimer);
    setLink('linking');

    let es;
    try { es = new EventSource(API.feed); }
    catch (_) { scheduleReconnect(); return; }
    S.es = es;

    es.addEventListener('open', async () => {
      const ok = await loadState();   // resync anything missed while dark
      S.backoff = BACKOFF.base;
      setLink(ok ? 'live' : 'linking');
    });

    // THE cue event — beatId lookup by id, never index.
    es.addEventListener('cue', (e) => {
      try { applyCue(JSON.parse(e.data)); } catch (_) { /* malformed: hold slide */ }
    });

    es.addEventListener('staged', (e) => {
      try {
        const d = JSON.parse(e.data);
        S.stagedId = d && d.staged ? d.staged : null;
        S.stagedSub = (d && d.submission) || (S.stagedId ? S.submissions.find((s) => s.id === S.stagedId) : null) || null;
        repaintLive();
      } catch (_) { /* ignore */ }
    });

    es.addEventListener('submission', (e) => {
      try {
        const sub = JSON.parse(e.data);
        if (!sub || sub.hidden) return;
        if (!S.submissions.some((s) => s.id === sub.id)) S.submissions.push(sub);
        if (S.submissions.length > 400) S.submissions.shift();
        if (S.stagedId && sub.id === S.stagedId) { S.stagedSub = sub; repaintLive(); }
      } catch (_) { /* ignore */ }
    });

    // assemblages move the LIVE histogram while the reveal slide is up
    es.addEventListener('assemblage', (e) => {
      try {
        const a = JSON.parse(e.data);
        if (!a || !a.sid) return;
        const bucket = (v) => Math.min(9, Math.max(0, Math.floor((+v || 0) / 10)));
        const i = S.assemblages.findIndex((x) => x.sid === a.sid);
        if (i >= 0) {
          const prev = S.assemblages[i];
          S.spectrumHistogram[bucket(prev.spectrum)] = Math.max(0, S.spectrumHistogram[bucket(prev.spectrum)] - 1);
          S.assemblages[i] = a;
        } else {
          S.assemblages.push(a);
        }
        S.spectrumHistogram[bucket(a.spectrum)] = (S.spectrumHistogram[bucket(a.spectrum)] || 0) + 1;
        repaintLive();
      } catch (_) { /* ignore */ }
    });

    es.addEventListener('moderate', (e) => {
      try {
        const m = JSON.parse(e.data);
        if (!m || !m.id) return;
        if (m.hidden) {
          S.submissions = S.submissions.filter((s) => s.id !== m.id);
          if (S.stagedId === m.id) { S.stagedSub = null; }
          repaintLive();
        } else { loadState(); }
      } catch (_) { /* ignore */ }
    });

    es.addEventListener('reset', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d && d.session) S.session = d.session;
      } catch (_) { /* ignore */ }
      loadState();
    });

    es.addEventListener('ping', () => { if (S.link !== 'live') setLink('live'); });

    es.addEventListener('error', () => {
      setLink('offline');
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
    S.reconnectTimer = setTimeout(connectFeed, wait);
  }

  // ── Keyboard: clicker only. Nothing here talks to the server. ────
  function initKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowRight': case 'PageDown': case ' ': case 'Spacebar':
          e.preventDefault(); step(1); break;
        case 'ArrowLeft': case 'PageUp': case 'Backspace':
          e.preventDefault(); step(-1); break;
        case 'f': case 'F':
          e.preventDefault();
          if (document.fullscreenElement) document.exitFullscreen?.();
          else document.documentElement.requestFullscreen?.().catch(() => {});
          break;
        case 'r': case 'R': loadState(); break;
        default: return;
      }
    });
  }

  // hide the pointer when idle — this is a projector, not a desktop
  function initCursor() {
    let t;
    document.addEventListener('mousemove', () => {
      el.body.classList.add('show-cursor');
      clearTimeout(t);
      t = setTimeout(() => el.body.classList.remove('show-cursor'), 2000);
    }, { passive: true });
  }

  // ── Boot ─────────────────────────────────────────────────────────
  // Radar axes/ghosts for the room-shape slide. Non-fatal: if this fails the
  // deck still runs, the radar slide just renders empty rather than throwing.
  async function loadRadarCatalog() {
    try {
      const res = await fetch('components.v2.json', { cache: 'no-cache' });
      if (!res.ok) return;
      const json = await res.json();
      S.axes = json.axes || [];
      S.axisOrder = (json.aggregation && json.aggregation.axisOrder)
        || S.axes.map((a) => a.id);
      S.ghosts = (json.ghosts || []).filter((g) => g.id !== 'ghost.room');
      repaintLive();
    } catch { /* optional */ }
  }

  async function start() {
    setLink('offline');
    initKeys();
    initCursor();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !S.es) connectFeed();
    });
    await loadDeck();
    await loadRadarCatalog();
    connectFeed();
    loadState();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.CYBORG_DECK = { state: S, step, reload: loadState, reconnect: connectFeed };
})();
