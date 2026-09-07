/* CYBORG // LIVE — audience app. Vanilla ES2020, no deps. */
(() => {
  'use strict';

  // ---------------------------------------------------------------- session
  const LS = {
    sid: 'cyborg.sid',
    handle: 'cyborg.handle',
    mode: 'cyborg.mode',
    picks: 'cyborg.picks',
    log: 'cyborg.log',
    open: 'cyborg.slots.open',
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

  let sid = lsGet(LS.sid, null);
  if (!sid) { sid = uuid(); lsSet(LS.sid, sid); }
  let handle = String(lsGet(LS.handle, '') || '').slice(0, 24);

  // ---------------------------------------------------------------- helpers
  const $ = (s, r = document) => r.querySelector(s);
  const pad = (n, w = 3) => String(Math.max(0, n | 0)).padStart(w, '0');
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === false || v == null) continue;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function postJSON(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `HTTP ${res.status} ${res.statusText || ''}`.trim();
      const e = new Error(msg); e.status = res.status; throw e;
    }
    return data;
  }

  // sysline (tiny transient status line)
  const sysline = el('div', { class: 'sysline', role: 'status', 'aria-live': 'polite' });
  document.body.append(sysline);
  let syslineT = 0;
  function say(msg) {
    sysline.textContent = msg;
    sysline.classList.add('is-show');
    clearTimeout(syslineT);
    syslineT = setTimeout(() => sysline.classList.remove('is-show'), 1800);
  }

  // ---------------------------------------------------------------- header
  $('#sid-readout').textContent = `SID ${sid.slice(0, 4).toUpperCase()}`;

  const pill = $('#link-pill');
  const pillState = $('#link-state');
  function setLink(state) {
    pill.classList.remove('is-live', 'is-warn', 'is-danger', 'is-pulsing');
    if (state === 'live') { pill.classList.add('is-live'); pillState.textContent = 'LIVE'; }
    else if (state === 'connecting') { pill.classList.add('is-pulsing'); pillState.textContent = 'CONNECTING'; }
    else { pill.classList.add('is-danger'); pillState.textContent = 'DOWN'; }
    pill.setAttribute('aria-label', `Link ${pillState.textContent.toLowerCase()}`);
  }

  // SSE feed: we only use it as a liveness signal on the audience side.
  let es = null, retryMs = 2000, retryT = 0;
  function connectFeed() {
    if (es) { es.close(); es = null; }
    setLink('connecting');
    try { es = new EventSource('/api/feed'); } catch { setLink('down'); scheduleRetry(); return; }
    es.onopen = () => { retryMs = 2000; setLink('live'); };
    es.onerror = () => {
      // 404 / server down: EventSource closes; otherwise it retries itself.
      if (es && es.readyState === EventSource.CLOSED) { setLink('down'); scheduleRetry(); }
      else setLink('connecting');
    };
    es.addEventListener('ping', () => setLink('live'));
    es.addEventListener('moderate', ev => {
      try { const m = JSON.parse(ev.data); markHidden(m.id, m.hidden); } catch { /* ignore */ }
    });
  }
  function scheduleRetry() {
    clearTimeout(retryT);
    retryT = setTimeout(connectFeed, retryMs);
    retryMs = Math.min(retryMs * 1.8, 30000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!es || es.readyState === EventSource.CLOSED)) { retryMs = 2000; connectFeed(); }
  });
  connectFeed();

  // ---------------------------------------------------------------- mode switch
  const seg = $('.seg');
  const tabs = [...document.querySelectorAll('.seg-btn')];
  const modes = { signal: $('#mode-signal'), assemble: $('#mode-assemble') };
  function setMode(name, { scroll = true } = {}) {
    if (!modes[name]) name = 'signal';
    seg.dataset.on = name;
    tabs.forEach(t => {
      const on = t.dataset.mode === name;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    for (const [k, sec] of Object.entries(modes)) sec.hidden = k !== name;
    lsSet(LS.mode, name);
    if (scroll) window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  }
  tabs.forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));
  seg.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = tabs[seg.dataset.on === 'assemble' ? 0 : 1]; // two tabs: either arrow toggles
    setMode(next.dataset.mode); next.focus();
  });
  setMode(location.hash === '#assemble' ? 'assemble' : lsGet(LS.mode, 'signal'), { scroll: false });

  // ---------------------------------------------------------------- shared handle inputs
  const handleInputs = [$('#handle'), $('#handle-2')];
  const handleCounter = $('#handle-counter');
  function syncHandle(v, from) {
    handle = v.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 24);
    handleInputs.forEach(i => { if (i !== from && i.value !== handle) i.value = handle; });
    handleCounter.textContent = `${pad(handle.length, 2)}/24`;
    lsSet(LS.handle, handle);
  }
  handleInputs.forEach(i => {
    i.value = handle;
    i.addEventListener('input', () => syncHandle(i.value, i));
  });
  syncHandle(handle);

  // ================================================================ MODE A: SIGNAL
  const form = $('#signal-form');
  const ta = $('#signal-text');
  const counter = $('#char-counter');
  const sendBtn = $('#send-btn');
  const sendLabel = $('.send-label', sendBtn);
  const sigErr = $('#signal-error');
  const logList = $('#log-list');
  const logCount = $('#log-count');
  const MAX = 280;

  const KIND_GLYPH = { question: '?', discussion: '⇄', note: '▸' };

  function updateCounter() {
    const n = [...ta.value].length; // code points, closer to what the user perceives
    counter.innerHTML = `${pad(n)}<span class="counter-sep">/</span>${MAX}`;
    counter.classList.toggle('is-warn', n >= 240 && n < MAX);
    counter.classList.toggle('is-danger', n >= MAX);
    ta.classList.toggle('is-over', n > MAX);
    const ok = ta.value.trim().length > 0 && n <= MAX;
    sendBtn.disabled = !ok || sending;
  }
  let sending = false;
  ta.addEventListener('input', () => { hideErr(sigErr); updateCounter(); });
  // Cmd/Ctrl+Enter submits (desktop nicety)
  ta.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') form.requestSubmit(); });

  function showErr(node, msg) { node.textContent = msg; node.hidden = false; }
  function hideErr(node) { node.hidden = true; node.textContent = ''; }

  // your own signals — persisted so a refresh doesn't lose the readouts
  let log = lsGet(LS.log, []).slice(-50);
  function renderLog() {
    logList.replaceChildren();
    logCount.textContent = pad(log.length);
    if (!log.length) {
      logList.append(el('li', { class: 'log-empty micro-label', text: 'NO SIGNALS SENT FROM THIS SESSION YET' }));
      return;
    }
    for (const item of [...log].reverse()) logList.append(renderLogItem(item));
  }
  function renderLogItem(item) {
    const t = new Date(item.ts || item.localTs);
    const hh = pad(t.getHours(), 2), mm = pad(t.getMinutes(), 2);
    const li = el('li', { class: `log-item is-${item.state}`, 'data-local': item.localId },
      el('span', { class: 'log-kind', text: KIND_GLYPH[item.kind] || '▸', 'aria-label': item.kind }),
      el('p', { class: 'log-text', text: item.text }),
      el('span', { class: 'log-meta micro-label', text: `${item.kind.toUpperCase()} · ${hh}:${mm}${item.handle ? ' · ' + item.handle : ''}${item.hidden ? ' · HIDDEN BY HOST' : ''}` }),
      el('span', { class: 'log-status' },
        el('span', { class: 'st', text: item.state === 'sending' ? 'SENDING' : item.state === 'received' ? 'RECEIVED' : 'FAILED' }),
        el('span', { class: 'log-id readout', text: item.id ? `ID ${item.id}` : (item.state === 'failed' ? (item.error || 'ERROR') : '········') }),
      ),
    );
    if (item.state === 'failed') {
      li.append(el('button', { class: 'log-retry', type: 'button', text: 'RETRY', onclick: () => retry(item.localId) }));
    }
    return li;
  }
  function saveLog() { lsSet(LS.log, log.slice(-50)); }
  function markHidden(id, hidden) {
    const it = log.find(x => x.id === id); if (!it) return;
    it.hidden = !!hidden; saveLog(); renderLog();
  }
  renderLog();

  async function transmitSignal(item) {
    sending = true;
    sendBtn.disabled = true;
    sendBtn.classList.add('is-busy');
    sendLabel.textContent = 'SENDING';
    try {
      const r = await postJSON('/api/submit', { sid, handle: handle || undefined, kind: item.kind, text: item.text });
      item.state = 'received'; item.id = r.id; item.ts = r.ts; item.error = null;
      sendLabel.textContent = `RECEIVED · ${r.id}`;
      say(`RECEIVED · ID ${r.id}`);
    } catch (e) {
      item.state = 'failed';
      item.error = e.status === 429 ? 'RATE LIMIT' : (e.status ? `HTTP ${e.status}` : 'NO LINK');
      const human = e.status === 429 ? 'Too fast — one signal every 3 seconds. Retry in a moment.'
        : e.status === 404 ? 'Server endpoint not found (/api/submit → 404). Your text is kept below; retry when the link is back.'
        : e.status ? `Server refused it: ${e.message}`
        : 'No link to the server. Your text is kept below; retry when the link is back.';
      showErr(sigErr, human);
      sendLabel.textContent = 'FAILED — RETRY?';
    } finally {
      saveLog(); renderLog();
      sending = false;
      sendBtn.classList.remove('is-busy');
      setTimeout(() => { sendLabel.textContent = 'SEND SIGNAL'; updateCounter(); }, item.state === 'received' ? 1400 : 0);
      updateCounter();
    }
  }
  function retry(localId) {
    const it = log.find(x => x.localId === localId); if (!it || sending) return;
    hideErr(sigErr);
    it.state = 'sending'; it.error = null; renderLog();
    transmitSignal(it);
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    if (sending) return;
    const text = ta.value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
    if (!text) { showErr(sigErr, 'Write something first.'); return; }
    if ([...text].length > MAX) { showErr(sigErr, `Over ${MAX} characters. Trim it.`); return; }
    const kind = (new FormData(form).get('kind') || 'question').toString();
    hideErr(sigErr);
    // optimistic: appears as SENDING immediately, before the network
    const item = { localId: uuid(), localTs: Date.now(), kind, text, handle, state: 'sending', id: null };
    log.push(item); log = log.slice(-50); saveLog(); renderLog();
    ta.value = ''; updateCounter();
    transmitSignal(item);
  });
  updateCounter();

  // ================================================================ MODE B: ASSEMBLE
  const slotsRoot = $('#slots');
  const spectrumNum = $('#spectrum-num');
  const klassOut = $('#klass-readout');
  const picksOut = $('#picks-count');
  const rulerFill = $('#ruler-fill');
  const rulerMarker = $('#ruler-marker');
  const rulerLabels = [...document.querySelectorAll('#ruler-labels li')];
  const transmitBtn = $('#transmit-btn');
  const transmitLabel = $('.send-label', transmitBtn);
  const transmitHint = $('#transmit-hint');
  const asmErr = $('#assemble-error');
  const card = $('#class-card');

  // ticks: every 5 minor, 10 mid, 25 major
  const ticks = $('#ruler-ticks');
  for (let v = 0; v <= 100; v += 5) {
    const i = document.createElement('i');
    i.style.left = v + '%';
    if (v % 25 === 0) i.className = 'is-major'; else if (v % 10 === 0) i.className = 'is-mid';
    ticks.append(i);
  }

  const ARCHETYPES = [[0, 'DAILY DESIGNER'], [25, 'RACE CAR DRIVER'], [50, 'PILOT'], [75, 'ASTRONAUT'], [100, 'VADER']];
  const archetypeFor = s => ARCHETYPES.reduce((best, a) => Math.abs(a[0] - s) < Math.abs(best[0] - s) ? a : best)[1];

  // hybrid prefixes when a second group is nearly as dominant
  const PREFIX = { BODY: 'Exo-', SENSES: 'Sensor ', COGNITION: 'Archival ', VOICE: 'Polyglot ', VEHICLE: 'Kinetic ', SOCIAL: 'Networked ', CRAFT: 'Artisan ' };

  let catalog = { groups: [], components: [] };
  let byId = new Map();
  let picks = new Set(lsGet(LS.picks, []));
  let openSlots = new Set(lsGet(LS.open, []));
  const SUM_REF = 40; // Σweight that maps to the top of the coverage term

  function compute() {
    const chosen = [...picks].map(id => byId.get(id)).filter(Boolean);
    const n = chosen.length;
    if (!n) return { spectrum: 0, klass: null, n, groups: [] };
    const sumW = chosen.reduce((a, c) => a + c.weight, 0);
    const avgW = sumW / n;
    // weighted normalised: 60% how much tech you've folded in, 40% how overtly cyborg it is
    const spectrum = Math.round(clamp(100 * (0.6 * Math.min(1, sumW / SUM_REF) + 0.4 * (avgW / 5)), 0, 100));
    const gw = {};
    for (const c of chosen) gw[c.group] = (gw[c.group] || 0) + c.weight;
    const groups = Object.entries(gw).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [g1, w1] = groups[0];
    const base = (catalog.groups.find(g => g.id === g1) || {}).klass || 'Steward';
    let klass = base;
    if (groups[1] && groups[1][1] >= 0.8 * w1 && PREFIX[groups[1][0]]) {
      klass = PREFIX[groups[1][0]] + base;
    }
    if (spectrum >= 90) klass = 'Dark ' + klass;
    else if (spectrum <= 12 && n <= 2) klass = 'Latent ' + klass;
    return { spectrum, klass, n, groups };
  }

  function renderState() {
    const s = compute();
    spectrumNum.textContent = pad(s.spectrum);
    picksOut.textContent = pad(s.n, 2);
    klassOut.textContent = s.klass || 'Unassembled';
    klassOut.classList.toggle('is-none', !s.klass);
    rulerFill.style.width = s.spectrum + '%';
    rulerMarker.style.left = s.spectrum + '%';
    rulerMarker.classList.toggle('is-idle', !s.n);
    const arch = archetypeFor(s.spectrum);
    const archAt = String(ARCHETYPES.find(a => a[1] === arch)[0]);
    rulerLabels.forEach(li => li.classList.toggle('is-near', !!s.n && li.dataset.at === archAt));
    transmitBtn.disabled = !s.n || transmitting;
    transmitHint.textContent = s.n ? `${arch} · ${s.klass}` : 'PICK AT LEAST ONE COMPONENT';
    transmitHint.classList.toggle('is-ok', !!s.n);
    // slot counts
    for (const g of catalog.groups) {
      const cnt = [...picks].filter(id => byId.get(id) && byId.get(id).group === g.id).length;
      const out = $(`#slot-${g.id} .slot-count`);
      if (out) { out.textContent = `${pad(cnt, 2)}/${pad(g.total, 2)}`; out.classList.toggle('is-on', cnt > 0); }
    }
    lsSet(LS.picks, [...picks]);
    return s;
  }

  function togglePick(id, btn) {
    const on = !picks.has(id);
    if (on) picks.add(id); else picks.delete(id);
    btn.setAttribute('aria-pressed', String(on));       // state flips synchronously (<100ms)
    hideErr(asmErr);
    renderState();
    if (!card.hidden) card.hidden = true;                 // editing after transmit invalidates the card
  }

  function buildSlots() {
    slotsRoot.replaceChildren();
    catalog.groups.forEach((g, gi) => {
      const comps = catalog.components.filter(c => c.group === g.id);
      g.total = comps.length;
      const panel = el('section', { class: 'fui-panel slot', id: `slot-${g.id}` });
      panel.append(el('span', { class: 'fui-corners', 'aria-hidden': 'true' }));
      const bodyId = `slot-body-${g.id}`;
      const isOpen = openSlots.has(g.id);
      panel.classList.toggle('is-open', isOpen);
      const head = el('button', { class: 'slot-head', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': bodyId },
        el('span', { class: 'slot-idx readout', text: `S${pad(gi + 1, 2)}` }),
        el('span', { class: 'slot-title' },
          el('span', { class: 'slot-name', text: g.label }),
          el('span', { class: 'slot-hint', text: g.hint })),
        el('span', { class: 'slot-count readout', text: `00/${pad(comps.length, 2)}` }),
        el('span', { class: 'slot-chev', 'aria-hidden': 'true', text: '▾' }),
      );
      head.addEventListener('click', () => {
        const open = !panel.classList.contains('is-open');
        panel.classList.toggle('is-open', open);
        head.setAttribute('aria-expanded', String(open));
        if (open) openSlots.add(g.id); else openSlots.delete(g.id);
        lsSet(LS.open, [...openSlots]);
      });
      const body = el('div', { class: 'slot-body', id: bodyId, role: 'group', 'aria-label': `${g.label} components` });
      for (const c of comps) {
        const on = picks.has(c.id);
        const b = el('button', { class: 'comp', type: 'button', 'aria-pressed': String(on), 'data-id': c.id },
          el('span', { class: 'comp-box', 'aria-hidden': 'true' }),
          el('span', { class: 'comp-main' },
            el('span', { class: 'comp-label', text: c.label }),
            el('span', { class: 'comp-blurb', text: c.blurb })),
          el('span', { class: 'comp-w', title: `weight ${c.weight}/5`, html: `<b>${'▮'.repeat(c.weight)}</b>${'▯'.repeat(5 - c.weight)}` }),
        );
        b.addEventListener('click', () => togglePick(c.id, b));
        body.append(b);
      }
      panel.append(head, body);
      slotsRoot.append(panel);
    });
    // open the first slot by default on first visit
    if (!openSlots.size && catalog.groups[0]) {
      const p = $(`#slot-${catalog.groups[0].id}`);
      p.classList.add('is-open'); $('.slot-head', p).setAttribute('aria-expanded', 'true');
    }
  }

  async function loadCatalog() {
    try {
      const res = await fetch('/components.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      catalog = await res.json();
      byId = new Map(catalog.components.map(c => [c.id, c]));
      picks = new Set([...picks].filter(id => byId.has(id)));
      buildSlots();
      renderState();
    } catch (e) {
      slotsRoot.replaceChildren(el('p', { class: 'inline-error', role: 'alert', text: `Catalog failed to load (${e.message}). Reload to retry.` }));
    }
  }

  // ---------- transmit + class card
  let transmitting = false;
  const cardEls = {
    id: $('#card-id'), klass: $('#card-klass'), handle: $('#card-handle'), spectrum: $('#card-spectrum'),
    archetype: $('#card-archetype'), picks: $('#card-picks'), marker: $('#card-marker'), groups: $('#card-groups'),
    list: $('#card-list'), status: $('#card-status'),
  };
  let lastCard = null;

  function renderCard(s, r) {
    const chosen = [...picks].map(id => byId.get(id)).filter(Boolean);
    cardEls.id.textContent = r && r.id ? `ID ${r.id}` : 'ID — LOCAL ONLY';
    cardEls.klass.textContent = s.klass;
    cardEls.handle.textContent = (handle || 'ANON').toUpperCase();
    cardEls.spectrum.textContent = `${pad(s.spectrum)}/100`;
    cardEls.archetype.textContent = archetypeFor(s.spectrum);
    cardEls.picks.textContent = pad(s.n, 2);
    cardEls.marker.style.left = s.spectrum + '%';
    cardEls.groups.replaceChildren(...s.groups.map(([g, w]) =>
      el('span', { class: 'card-group', html: `${g} <b>${pad(w, 2)}</b>` })));
    cardEls.list.replaceChildren(...chosen.map(c => el('li', { text: c.label })));
    cardEls.status.textContent = r && r.id ? `LOGGED ${new Date(r.ts).toLocaleTimeString()}` : 'NOT LOGGED ON SERVER — CARD IS LOCAL';
    card.classList.toggle('is-danger', !(r && r.id));
    card.hidden = false;
    lastCard = { s, r, chosen };
    card.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  }

  transmitBtn.addEventListener('click', async () => {
    if (transmitting) return;
    const s = compute();
    if (!s.n) { showErr(asmErr, 'Pick at least one component first.'); return; }
    hideErr(asmErr);
    transmitting = true;
    transmitBtn.disabled = true;
    transmitBtn.classList.add('is-busy');
    transmitLabel.textContent = 'TRANSMITTING';
    try {
      const r = await postJSON('/api/assemblage', { sid, handle: handle || undefined, picks: [...picks], spectrum: s.spectrum, klass: s.klass });
      transmitLabel.textContent = `RECEIVED · ${r.id}`;
      say(`ASSEMBLAGE LOGGED · ID ${r.id}`);
      renderCard(s, r);
    } catch (e) {
      const human = e.status === 404
        ? 'Server endpoint not found (/api/assemblage → 404). Your class card is shown locally below; it was not logged.'
        : e.status ? `Server refused it: ${e.message}`
        : 'No link to the server. Your class card is shown locally below; it was not logged.';
      showErr(asmErr, human);
      transmitLabel.textContent = 'FAILED — RETRY?';
      renderCard(s, null);
    } finally {
      transmitting = false;
      transmitBtn.classList.remove('is-busy');
      renderState();
      setTimeout(() => { transmitLabel.textContent = 'TRANSMIT ASSEMBLAGE'; }, 1600);
    }
  });

  $('#card-edit').addEventListener('click', () => {
    card.hidden = true;
    $('#spectrum-panel').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  });

  $('#card-share').addEventListener('click', async () => {
    if (!lastCard) return;
    const { s, r, chosen } = lastCard;
    const text = [
      `CYBORG // LIVE — class card`,
      `${s.klass.toUpperCase()} · ${archetypeFor(s.spectrum)} · ${pad(s.spectrum)}/100`,
      handle ? `handle: ${handle}` : null,
      `assemblage: ${chosen.map(c => c.label).join(', ')}`,
      r && r.id ? `id ${r.id}` : null,
    ].filter(Boolean).join('\n');
    try {
      if (navigator.share) { await navigator.share({ title: 'CYBORG // LIVE', text }); say('SHARED'); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); say('COPIED TO CLIPBOARD'); }
    catch { cardEls.status.textContent = text; say('COPY MANUALLY'); }
  });

  loadCatalog();
})();
