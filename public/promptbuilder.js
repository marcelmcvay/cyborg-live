/* CYBORG // LIVE — Prompt Builder. Vanilla ES2020, no deps.
   Standalone page (per CONTRACT.md agent ownership table): public/promptbuilder.html/.css/.js
   Consumes: GET prompt-format.json (static, slot copy), GET /api/state (seed tally),
             GET /api/feed SSE event `promptpiece` (live tally), POST /api/prompt-piece. */
(() => {
  'use strict';

  // ---------------------------------------------------------------- session
  // Same localStorage convention as public/app.js: namespaced keys, sid is a
  // crypto.randomUUID() generated once and reused; handle is optional, <=24 chars.
  const LS = {
    sid: 'cyborg.sid',
    handle: 'cyborg.handle',
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
  const escapeText = (s) => String(s == null ? '' : s);

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

  // ---------------------------------------------------------------- header
  const sidReadout = $('#sid-readout');
  if (sidReadout) sidReadout.textContent = `SID ${sid.slice(0, 4).toUpperCase()}`;

  const pill = $('#link-pill');
  const pillState = $('#link-state');
  function setLink(state) {
    pill.classList.remove('is-live', 'is-warn', 'is-danger', 'is-pulsing');
    if (state === 'live') { pill.classList.add('is-live'); pillState.textContent = 'LIVE'; }
    else if (state === 'connecting') { pill.classList.add('is-pulsing'); pillState.textContent = 'CONNECTING'; }
    else { pill.classList.add('is-danger'); pillState.textContent = 'DOWN'; }
    pill.setAttribute('aria-label', `Link ${pillState.textContent.toLowerCase()}`);
  }

  // ---------------------------------------------------------------- handle field
  const handleInput = $('#handle-input');
  if (handleInput) {
    handleInput.value = handle;
    handleInput.addEventListener('input', () => {
      handle = handleInput.value.slice(0, 24);
      lsSet(LS.handle, handle);
    });
  }

  // ---------------------------------------------------------------- state
  // slots: array from prompt-format.json (order + copy authoritative source)
  // counts: { SLOT_ID: n }   recent: { SLOT_ID: [{id,ts,sid,handle,text}, ...] }
  let slots = [];
  let counts = {};
  let recent = {};
  let currentSlot = null; // slot id open in compose view

  const gridErrorEl = $('#grid-error');
  function showGridError(msg) {
    if (!gridErrorEl) return;
    gridErrorEl.textContent = msg;
    gridErrorEl.hidden = !msg;
  }

  // ---------------------------------------------------------------- render: slot grid
  const slotGridEl = $('#slot-grid');
  const slotsLoadingEl = $('#slots-loading');

  function renderGrid() {
    if (!slotGridEl) return;
    slotGridEl.innerHTML = '';
    if (!slots.length) {
      slotGridEl.append(slotsLoadingEl || el('p', { class: 'micro-label slots-loading', text: 'LOADING SLOTS…' }));
      return;
    }
    for (const slot of slots) {
      const count = counts[slot.id] || 0;
      const pieces = (recent[slot.id] || []).slice(-3).reverse(); // newest first, up to 3
      const card = el('button', {
        class: 'slot-card', type: 'button', 'data-slot': slot.id,
        onclick: () => openCompose(slot.id),
      },
        el('span', { class: 'fui-corners', 'aria-hidden': 'true' }),
        el('div', { class: 'slot-card-head' },
          el('span', { class: 'micro-label slot-card-id', text: slot.id }),
          el('span', { class: 'slot-card-count readout', id: `count-${slot.id}`, text: pad(count) }),
        ),
        el('div', { class: 'slot-card-label display', text: slot.label || slot.id }),
        el('p', { class: 'slot-card-hint', text: slot.hint || '' }),
        pieces.length ? el('div', { class: 'slot-card-chips' },
          ...pieces.map(p => el('span', { class: 'chip', text: p.text }))
        ) : null,
        el('div', { class: 'slot-card-cta' },
          el('span', { text: 'ADD A PHRASE' }),
          el('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' }),
        ),
      );
      slotGridEl.append(card);
    }
  }

  function bumpCard(slotId) {
    if (reducedMotion) return;
    const card = slotGridEl && slotGridEl.querySelector(`.slot-card[data-slot="${slotId}"]`);
    if (card) {
      card.classList.remove('is-pulsing'); void card.offsetWidth; card.classList.add('is-pulsing');
      setTimeout(() => card.classList.remove('is-pulsing'), 950);
    }
    const countEl = document.getElementById(`count-${slotId}`);
    if (countEl) {
      countEl.classList.remove('is-bump'); void countEl.offsetWidth; countEl.classList.add('is-bump');
      setTimeout(() => countEl.classList.remove('is-bump'), 350);
    }
  }

  // ---------------------------------------------------------------- views
  const viewGrid = $('#view-grid');
  const viewCompose = $('#view-compose');
  const backBtn = $('#back-btn');

  function openCompose(slotId) {
    const slot = slots.find(s => s.id === slotId);
    if (!slot) return;
    currentSlot = slotId;
    $('#compose-slot-id').textContent = slot.id;
    $('#compose-label').textContent = slot.label || slot.id;
    $('#compose-hint').textContent = slot.hint || '';
    $('#compose-count').textContent = `${pad(counts[slot.id] || 0)} SUBMITTED`;
    const ta = $('#compose-text');
    ta.value = '';
    ta.placeholder = slot.placeholder || 'type here';
    updateCounter();
    setSubmitState('idle');
    $('#compose-error').hidden = true;
    const statusEl = $('#compose-status');
    statusEl.hidden = true; statusEl.textContent = '';
    renderRecentChips();
    viewGrid.hidden = true;
    viewCompose.hidden = false;
    window.scrollTo(0, 0);
    ta.focus({ preventScroll: true });
  }

  function closeCompose() {
    currentSlot = null;
    viewCompose.hidden = true;
    viewGrid.hidden = false;
    renderGrid();
  }
  if (backBtn) backBtn.addEventListener('click', closeCompose);

  // ---------------------------------------------------------------- compose form
  const composeForm = $('#compose-form');
  const composeText = $('#compose-text');
  const composeCounter = $('#compose-counter');
  const composeSubmit = $('#compose-submit');
  const composeSubmitLabel = $('#compose-submit-label');
  const composeErrorEl = $('#compose-error');
  const composeStatusEl = $('#compose-status');
  const composeRecentEl = $('#compose-recent');

  function updateCounter() {
    const len = composeText.value.length;
    composeCounter.innerHTML = '';
    composeCounter.append(pad(len, 2), el('span', { class: 'counter-sep', text: '/' }), '60');
    composeCounter.classList.remove('is-near', 'is-max');
    if (len >= 60) composeCounter.classList.add('is-max');
    else if (len >= 48) composeCounter.classList.add('is-near');
    validateForClient();
  }

  // CONSTRAINT: submit stays disabled until text is valid — enforced client-side
  // before any network call, matching the "reject invalid input before hitting
  // the network where possible" requirement.
  function validateForClient() {
    const text = composeText.value.trim();
    const valid = text.length >= 1 && text.length <= 60 && !!currentSlot && slots.some(s => s.id === currentSlot);
    composeSubmit.disabled = !valid;
    return valid;
  }

  composeText.addEventListener('input', updateCounter);

  function setSubmitState(state, label) {
    composeSubmit.classList.remove('is-sending', 'is-received', 'is-error');
    if (state === 'sending') { composeSubmit.classList.add('is-sending'); composeSubmitLabel.textContent = label || 'SENDING…'; composeSubmit.disabled = true; }
    else if (state === 'received') { composeSubmit.classList.add('is-received'); composeSubmitLabel.textContent = label || 'RECEIVED'; }
    else if (state === 'error') { composeSubmit.classList.add('is-error'); composeSubmitLabel.textContent = label || 'ERROR — TAP TO RETRY'; composeSubmit.disabled = false; }
    else { composeSubmitLabel.textContent = 'ADD TO POOL'; }
  }

  function setStatus(msg, cls) {
    composeStatusEl.textContent = msg;
    composeStatusEl.hidden = !msg;
    composeStatusEl.classList.remove('is-accent', 'is-warn');
    if (cls) composeStatusEl.classList.add(cls);
  }

  composeForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    composeErrorEl.hidden = true;
    if (!currentSlot) return;

    // client-side validation BEFORE any network call
    const rawText = composeText.value;
    const text = rawText.trim();
    if (!text) {
      composeErrorEl.textContent = 'text required (1..60 chars)';
      composeErrorEl.hidden = false;
      return;
    }
    if (text.length > 60) {
      composeErrorEl.textContent = 'text must be 60 characters or fewer';
      composeErrorEl.hidden = false;
      return;
    }
    if (!slots.some(s => s.id === currentSlot)) {
      composeErrorEl.textContent = `slot must be one of ${slots.map(s => s.id).join('|')}`;
      composeErrorEl.hidden = false;
      return;
    }

    // OPTIMISTIC UI: visible state change within 100ms, before the network call resolves
    setSubmitState('sending');
    setStatus('SENDING…');

    try {
      const data = await postJSON('api/prompt-piece', { sid, handle: handle || undefined, slot: currentSlot, text });
      setSubmitState('received', 'RECEIVED');
      setStatus(`RECEIVED · ID ${String(data.id).slice(0, 8).toUpperCase()}`, 'is-accent');
      // Optimistically fold into local tally immediately; the SSE echo (if it
      // arrives) is deduped by id so this never double-counts.
      applyNewPiece({ id: data.id, ts: data.ts, sid, handle, slot: currentSlot, text });
      composeText.value = '';
      updateCounter();
      $('#compose-count').textContent = `${pad(counts[currentSlot] || 0)} SUBMITTED`;
      setTimeout(() => { setSubmitState('idle'); setStatus(''); }, 1600);
    } catch (err) {
      if (err.status === 429) {
        setSubmitState('error', 'SLOW DOWN — TRY AGAIN');
        setStatus(err.message || 'Slow down — you can only submit every few seconds.', 'is-warn');
      } else {
        setSubmitState('error', 'ERROR — TAP TO RETRY');
        composeErrorEl.textContent = err.message || 'submission failed';
        composeErrorEl.hidden = false;
        setStatus('');
      }
    }
  });

  // reset button visual state on any further edit after an error/received flash
  composeText.addEventListener('focus', () => {
    if (composeSubmit.classList.contains('is-error')) { setSubmitState('idle'); composeErrorEl.hidden = true; }
  });

  function renderRecentChips() {
    if (!composeRecentEl || !currentSlot) return;
    composeRecentEl.innerHTML = '';
    const pieces = (recent[currentSlot] || []).slice(-3).reverse();
    if (!pieces.length) {
      composeRecentEl.append(el('li', { class: 'chip-empty', text: 'NOTHING SUBMITTED YET — BE FIRST' }));
      return;
    }
    for (const p of pieces) {
      composeRecentEl.append(el('li', { class: 'chip-row' },
        el('span', { class: 'chip-row-text', text: p.text }),
        p.handle ? el('span', { class: 'chip-row-who', text: p.handle }) : null,
      ));
    }
  }

  // ---------------------------------------------------------------- live tally application
  const seenIds = new Set();
  function applyNewPiece(piece) {
    if (!piece || !piece.slot) return;
    if (piece.id && seenIds.has(piece.id)) return;
    if (piece.id) seenIds.add(piece.id);
    counts[piece.slot] = (counts[piece.slot] || 0) + 1;
    const arr = recent[piece.slot] || (recent[piece.slot] = []);
    arr.push(piece);
    if (arr.length > 8) arr.shift();

    // update grid card in place if visible
    const countEl = document.getElementById(`count-${piece.slot}`);
    if (countEl) countEl.textContent = pad(counts[piece.slot]);
    else renderGrid();
    bumpCard(piece.slot);
    // refresh chip previews on the card (cheap full grid re-render keeps this simple)
    renderGrid();

    // if compose view for this slot is open, refresh its recent list + count readout
    if (currentSlot === piece.slot) {
      const cCount = $('#compose-count');
      if (cCount) cCount.textContent = `${pad(counts[piece.slot] || 0)} SUBMITTED`;
      renderRecentChips();
      const rows = composeRecentEl && composeRecentEl.querySelectorAll('.chip-row');
      if (rows && rows.length && !reducedMotion) {
        rows[0].classList.add('is-new');
        setTimeout(() => rows[0] && rows[0].classList.remove('is-new'), 550);
      }
    }
  }

  // ---------------------------------------------------------------- boot: slot format + seed state
  async function loadFormat() {
    const res = await fetch('prompt-format.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`prompt-format.json HTTP ${res.status}`);
    const data = await res.json();
    slots = Array.isArray(data.slots) ? data.slots : [];
    const titleEl = $('#pb-title');
    if (titleEl && data.title) titleEl.textContent = data.title;
  }

  async function loadState() {
    const res = await fetch('api/state', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`api/state HTTP ${res.status}`);
    const data = await res.json();
    counts = data.promptCounts || {};
    recent = data.promptPieces || {};
    for (const slotId of Object.keys(recent)) {
      for (const p of recent[slotId]) if (p.id) seenIds.add(p.id);
    }
  }

  async function boot() {
    try {
      await loadFormat();
    } catch (err) {
      showGridError(`Could not load slot list: ${err.message}`);
    }
    try {
      await loadState();
    } catch (err) {
      showGridError(`Could not load live tally: ${err.message}`);
    }
    renderGrid();
    connectFeed();
  }

  // ---------------------------------------------------------------- SSE live feed
  // Subscribes to `promptpiece` events (per CONTRACT.md) to increment the tally
  // incrementally, rather than re-polling /api/state.
  let es = null, retryMs = 2000, retryT = 0;
  function connectFeed() {
    if (es) { es.close(); es = null; }
    setLink('connecting');
    try { es = new EventSource('api/feed'); } catch { setLink('down'); scheduleRetry(); return; }
    es.onopen = () => { retryMs = 2000; setLink('live'); };
    es.onerror = () => {
      if (es && es.readyState === EventSource.CLOSED) { setLink('down'); scheduleRetry(); }
      else setLink('connecting');
    };
    es.addEventListener('ping', () => setLink('live'));
    es.addEventListener('promptpiece', (ev) => {
      try { applyNewPiece(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
    });
  }
  function scheduleRetry() {
    clearTimeout(retryT);
    retryT = setTimeout(connectFeed, retryMs);
    retryMs = Math.min(retryMs * 1.6, 15000);
  }

  boot();
})();
