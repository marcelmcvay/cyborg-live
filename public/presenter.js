/* ═══════════════════════════════════════════════════════════════════
   CYBORG // LIVE — presenter.js
   Big-screen view. Vanilla ES2020, no deps.
   Data: GET /api/state on boot, then EventSource /api/feed.
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────
  const API = {
    state: 'api/state',
    feed: 'api/feed',
    moderate: 'api/moderate',
  };
  const ADMIN_KEY_LS = 'cyborg.adminKey';
  const MAX_CARDS = 60;               // DOM cap; feed is newest-first
  const KINDS = ['question', 'discussion', 'note'];
  const SPECTRUM_LABELS = ['DAILY DESIGNER', 'RACE CAR DRIVER', 'PILOT', 'ASTRONAUT', 'VADER'];
  const KLASS_ROTATE_MS = 8000;
  const BACKOFF = { base: 1000, max: 30000 };
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── State ────────────────────────────────────────────────────────
  const S = {
    submissions: [],        // newest first, hidden excluded
    assemblages: [],        // one per sid, newest last (as delivered)
    counts: { question: 0, discussion: 0, note: 0, assemblages: 0 },
    spectrumHistogram: new Array(10).fill(0),
    componentTally: {},
    componentLabels: {},    // id -> label (from components.json, best effort)
    filter: 'all',
    modVisible: true,
    link: 'offline',        // offline | linking | live
    es: null,
    backoff: BACKOFF.base,
    reconnectTimer: null,
    klassIdx: 0,
    klassTimer: null,
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
    spectrumMeta: $('#spectrumMeta'),
    rulerTicks: $('#rulerTicks'),
    rulerLabels: $$('.ruler__labels span'),
    tally: $('#tally'),
    tallyEmpty: $('#tallyEmpty'),
    klassBody: $('#klassBody'),
    klassIdx: $('#klassIdx'),
    klassHandle: $('#klassHandle'),
    klassPicks: $('#klassPicks'),
    klassSpectrum: $('#klassSpectrum'),
    ftrStatus: $('#ftrStatus'),
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
  }

  // ── Spectrum histogram ───────────────────────────────────────────
  function initRuler() {
    // 20 minor ticks, major every 5 (0/25/50/75/100)
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 20; i++) {
      const t = document.createElement('i');
      if (i % 5 === 0) t.className = 'major';
      frag.appendChild(t);
    }
    el.rulerTicks.replaceChildren(frag);

    // initial 10 empty bars
    const bars = document.createDocumentFragment();
    for (let i = 0; i < 10; i++) {
      const b = document.createElement('div');
      b.className = 'hist__bar';
      b.dataset.n = '0';
      b.style.setProperty('--h', '0%');
      b.innerHTML = '<span class="hist__n readout">0</span>';
      b.title = `${i * 10}–${i * 10 + 10}`;
      bars.appendChild(b);
    }
    el.hist.replaceChildren(bars);
  }

  function renderSpectrum() {
    const h = Array.isArray(S.spectrumHistogram) && S.spectrumHistogram.length === 10
      ? S.spectrumHistogram.map((x) => x | 0)
      : new Array(10).fill(0);
    const max = Math.max(1, ...h);
    const total = h.reduce((a, b) => a + b, 0);
    const bars = $$('.hist__bar', el.hist);
    let maxIdx = -1;
    h.forEach((n, i) => {
      const b = bars[i];
      b.dataset.n = String(n);
      b.style.setProperty('--h', `${(n / max) * 100}%`);
      $('.hist__n', b).textContent = String(n);
      b.classList.toggle('is-max', n > 0 && n === max);
      if (n === max && n > 0 && maxIdx < 0) maxIdx = i;
    });

    // mean from assemblages if available, else bucket midpoints
    let mean = null;
    if (S.assemblages.length) {
      mean = S.assemblages.reduce((a, x) => a + (+x.spectrum || 0), 0) / S.assemblages.length;
    } else if (total) {
      mean = h.reduce((a, n, i) => a + n * (i * 10 + 5), 0) / total;
    }
    el.spectrumMeta.textContent = `N=${pad(total)} · μ=${mean == null ? '—' : pad(Math.round(mean))}`;

    // highlight the label nearest the modal bucket
    const modeLabel = maxIdx < 0 ? -1 : Math.round(((maxIdx * 10 + 5) / 100) * 4);
    el.rulerLabels.forEach((s, i) => s.classList.toggle('is-mode', i === modeLabel));
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
    renderFeed();
    renderCounts();
    renderSpectrum();
    renderTally();
    renderKlass(false);
  }

  // best-effort: component labels for the tally (frontend agent authors this file)
  async function loadComponentLabels() {
    try {
      const res = await fetch('components.json', { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      const list = Array.isArray(json) ? json : (json.components || []);
      for (const c of list) if (c && c.id) S.componentLabels[c.id] = c.label || c.id;
      renderTally();
    } catch { /* optional */ }
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
        if (m.hidden) removeSubmission(m.id);
        else loadState();     // un-hide: simplest correct path is a resync
      } catch { /* ignore */ }
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
        case 'r': case 'R': loadState(); break;
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
    setLink('offline');
    renderCounts();
    renderSpectrum();
    renderTally();
    renderKlass(false);
    updateEmpty();
    startKlassRotation();
    loadComponentLabels();
    // loadState runs inside the SSE 'open' handler so we never miss events
    // between state fetch and stream attach; if SSE never opens we still
    // try state once so a static-served presenter shows whatever it can.
    connectFeed();
    loadState();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // tiny debug hook for the operator console
  window.CYBORG_PRESENTER = { state: S, setFilter, reload: loadState, reconnect: connectFeed };
})();
