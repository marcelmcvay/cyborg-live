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
    cue: 'cyborg.cue',
    gates: 'cyborg.gates',
    card: 'cyborg.card',
    ghosts: 'cyborg.ghosts',
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
      const e = new Error(msg); e.status = res.status; e.body = data; throw e;
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
    try { es = new EventSource('api/feed'); } catch { setLink('down'); scheduleRetry(); return; }
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
    // ---- control track: the presenter drives what this phone offers ----
    es.addEventListener('cue', ev => {
      try { onCueFrame(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
    });
    es.addEventListener('reset', ev => {
      // new session: drop the sticky open-gates ratchet, take the fresh cue
      try {
        const d = JSON.parse(ev.data);
        onCueFrame(d && d.cue ? d.cue : null, { reset: true });
      } catch { /* ignore */ }
    });
    // ---- COLLECTIVE tab: style ideas + prompt-piece voting/pinning ----
    es.addEventListener('styleidea', ev => {
      try { onStyleIdea(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
    });
    es.addEventListener('promptvote', ev => {
      try { onPromptVote(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
    });
    es.addEventListener('promptpin', ev => {
      try { onPromptPin(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
    });
  }
  // connectFeed() runs before the cue block's bindings exist, so frames that
  // land during boot are queued rather than dropped (or thrown into a TDZ).
  let booted = false;
  let pendingCue = null;
  function onCueFrame(c, opts = {}) {
    if (!booted) { pendingCue = { c, opts }; return; }
    if (opts.reset) gates = { signal: false, assemble: false };
    applyCue(c, opts);
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
  const modes = { signal: $('#mode-signal'), assemble: $('#mode-assemble'), collective: $('#mode-collective') };
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
  // a locked tab is still tappable: tapping it shows the gate that explains why,
  // which beats a dead control that silently does nothing.
  tabs.forEach(t => t.addEventListener('click', () => noteTabTap(t.dataset.mode)));
  seg.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const curIdx = tabs.findIndex(t => t.dataset.mode === seg.dataset.on);
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(curIdx + delta + tabs.length) % tabs.length];
    setMode(next.dataset.mode); next.focus();
  });
  setMode(location.hash === '#signal' ? 'signal' : lsGet(LS.mode, 'assemble'), { scroll: false });

  // ================================================================ CONTROL TRACK (cue)
  // The presenter advances beats; state.cue tells forty phones what they may do.
  // signalOpen / assembleOpen are AUTHORITATIVE booleans — we never infer
  // availability from the mode name. Mode only supplies framing + where to look.
  const MODE_COPY = {
    intro:    { look: null },
    assemble: { look: 'assemble' },
    reveal:   { look: 'assemble' },
    present:  { look: 'signal' },
    panel:    { look: 'signal' },
    steward:  { look: 'signal' },
    closed:   { look: null },
  };

  // Two standing rules from Marcel, enforced client-side as a ratchet:
  //   SIGNAL opens once and never closes.  ASSEMBLE stays editable all talk.
  // A cue can only ever OPEN a gate. The single exception is an explicit
  // `closed` beat, which is allowed to shut the room down.
  let gates = lsGet(LS.gates, { signal: false, assemble: false }) || { signal: false, assemble: false };
  gates = { signal: !!gates.signal, assemble: !!gates.assemble };
  let cue = lsGet(LS.cue, null);

  // ---- cue bar (built here: index.html is fixed, so new UI comes from JS) ----
  const cueBar = el('section', { class: 'cuebar', id: 'cuebar', 'aria-live': 'polite' });
  const cueMeta = el('div', { class: 'cuebar-meta' });
  const cueBeat = el('span', { class: 'micro-label cuebar-beat', text: 'STANDBY' });
  const cueGates = el('div', { class: 'cuebar-gates' });
  const gatePills = {
    signal: el('span', { class: 'pill gate-pill', 'data-for': 'signal' },
      el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { text: 'SIGNAL' }),
      el('span', { class: 'pill-state', text: 'LOCKED' })),
    assemble: el('span', { class: 'pill gate-pill', 'data-for': 'assemble' },
      el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { text: 'ASSEMBLE' }),
      el('span', { class: 'pill-state', text: 'LOCKED' })),
  };
  cueGates.append(gatePills.signal, gatePills.assemble);
  // cueMeta (beat name + SIGNAL/ASSEMBLE gate pills) is deliberately NOT
  // appended. Every beat in the running deck opens both gates, so the pills
  // read "OPEN / OPEN" for the entire talk, and the beat name is presenter
  // vocabulary the audience cannot act on. The nodes stay alive so
  // renderGates() can keep writing to them without null checks.
  cueMeta.append(cueBeat, cueGates);
  const cuePrompt = el('p', { class: 'cuebar-prompt display', id: 'cue-prompt' });
  const cueChange = el('div', { class: 'cuebar-change', id: 'cue-change', role: 'status', hidden: true });
  const cueChangeText = el('span', { class: 'cuebar-change-text' });
  const cueChangeBtn = el('button', { class: 'cuebar-change-go', type: 'button', hidden: true });
  cueChange.append(el('span', { class: 'cuebar-change-mark', 'aria-hidden': 'true', text: '▸' }), cueChangeText, cueChangeBtn);
  cueBar.append(cuePrompt, cueChange);
  const mainEl = $('#main');
  document.body.insertBefore(cueBar, mainEl);

  // ---- gate panels: what you see INSTEAD of a composer that isn't offered ----
  function buildGate(which, title, body) {
    const g = el('div', { class: 'fui-panel gate', id: `gate-${which}` },
      el('span', { class: 'fui-corners', 'aria-hidden': 'true' }),
      el('span', { class: 'gate-lock', 'aria-hidden': 'true' }),
      el('span', { class: 'micro-label gate-tag', text: 'NOT OPEN YET' }),
      el('p', { class: 'gate-title display', text: title }),
      el('p', { class: 'gate-body', id: `gate-body-${which}` , text: body }),
      el('p', { class: 'micro-label gate-wait', text: 'WAITS FOR THE PRESENTER · OPENS ON ITS OWN' }));
    return g;
  }
  const gateEls = {
    signal: buildGate('signal', 'Signal is not open',
      'Marcel opens this at the reveal. Once it opens it stays open for the rest of the talk.'),
    assemble: buildGate('assemble', 'Assemble is not open',
      'The builder opens a couple of minutes in. Once it opens you can revise your picks for the whole talk.'),
  };
  modes.signal.insertBefore(gateEls.signal, $('.signal-form', modes.signal));
  modes.assemble.insertBefore(gateEls.assemble, $('#spectrum-panel'));

  // lock signifier on the mode tabs
  const tabLocks = {};
  tabs.forEach(t => {
    const lk = el('span', { class: 'seg-lock', 'aria-hidden': 'true', text: '⊘' });
    t.append(lk);
    tabLocks[t.dataset.mode] = lk;
  });
  // COLLECTIVE is not part of the presenter cue/gate system (no collectiveOpen
  // field exists in the cue contract) — it is always on offer, so it never
  // wears the lock signifier the other two tabs use.
  if (tabLocks.collective) tabLocks.collective.hidden = true;

  const isOpen = which => which === 'collective' ? true : !!gates[which];

  function renderGates() {
    for (const which of ['signal', 'assemble']) {
      const on = isOpen(which);
      const sec = modes[which];
      sec.classList.toggle('is-locked', !on);
      const pill = gatePills[which];
      pill.classList.toggle('is-live', on);
      $('.pill-state', pill).textContent = on ? 'OPEN' : 'LOCKED';
      const tab = tabs.find(t => t.dataset.mode === which);
      tab.classList.toggle('is-locked', !on);
      tab.setAttribute('aria-disabled', String(!on));
      tabLocks[which].hidden = on;
    }
    // never leave someone parked on a section that offers nothing
    const cur = seg.dataset.on;
    if (!isOpen(cur)) {
      const other = cur === 'signal' ? 'assemble' : 'signal';
      if (isOpen(other)) setMode(other, { scroll: false });
    }
  }

  function noteTabTap(which) {
    if (isOpen(which)) return;
    // tapped a locked tab: say why, out loud, instead of failing silently
    const sec = modes[which];
    sec.classList.remove('is-flash'); void sec.offsetWidth; sec.classList.add('is-flash');
    say(`${which.toUpperCase()} NOT OPEN YET`);
  }

  let cueChangeT = 0;
  function flashChange(msg, goTo) {
    cueChangeText.textContent = msg;
    if (goTo && isOpen(goTo)) {
      cueChangeBtn.hidden = false;
      cueChangeBtn.textContent = `GO TO ${goTo.toUpperCase()} →`;
      cueChangeBtn.onclick = () => { setMode(goTo); cueChange.hidden = true; };
    } else {
      cueChangeBtn.hidden = true;
      cueChangeBtn.onclick = null;
    }
    cueChange.hidden = false;
    cueChange.classList.remove('is-in'); void cueChange.offsetWidth; cueChange.classList.add('is-in');
    clearTimeout(cueChangeT);
    cueChangeT = setTimeout(() => {
      cueChange.classList.remove('is-in');
      // pull it out of layout once faded, so it doesn't hold dead vertical space
      setTimeout(() => { if (!cueChange.classList.contains('is-in')) cueChange.hidden = true; }, 220);
    }, 12000);
  }

  function applyCue(next, { reset = false, initial = false } = {}) {
    const prev = cue;
    const c = next && typeof next === 'object' ? next : { mode: 'intro', beatId: 'intro', label: 'INTRO', prompt: '', signalOpen: false, assembleOpen: false };
    const mode = MODE_COPY[c.mode] ? c.mode : 'intro';
    const before = { ...gates };

    if (c.mode === 'closed') {
      // the ONLY path that closes anything
      gates = { signal: !!c.signalOpen, assemble: !!c.assembleOpen };
    } else if (reset) {
      gates = { signal: !!c.signalOpen, assemble: !!c.assembleOpen };
    } else {
      // ratchet: a gate can open, never close
      gates = {
        signal: gates.signal || !!c.signalOpen,
        assemble: gates.assemble || !!c.assembleOpen,
      };
    }

    cue = c;
    lsSet(LS.cue, cue);
    lsSet(LS.gates, gates);

    // --- headline instruction, 120-200ms legible swap ---
    const promptText = (c.prompt || '').trim();
    const changedPrompt = !prev || prev.prompt !== c.prompt || prev.beatId !== c.beatId;
    const paint = () => {
      cuePrompt.textContent = promptText;
      cuePrompt.hidden = !promptText;
      cueBeat.textContent = (c.label || mode).toUpperCase();
      cueBar.dataset.mode = mode;
      cueBar.classList.remove('is-swap');
    };
    if (changedPrompt && !initial && !reducedMotion) {
      cueBar.classList.add('is-swap');           // 140ms out
      setTimeout(paint, 140);                     // then in
    } else paint();

    renderGates();
    syncAssembleAffordances();

    if (initial) return;

    // --- make the change legible: what opened, and where to look ---
    const opened = [];
    if (!before.signal && gates.signal) opened.push('signal');
    if (!before.assemble && gates.assemble) opened.push('assemble');
    const closed = (before.signal && !gates.signal) || (before.assemble && !gates.assemble);
    const look = MODE_COPY[mode].look;

    if (opened.length) {
      const w = opened[0];
      flashChange(`${opened.map(s => s.toUpperCase()).join(' + ')} JUST OPENED`, isOpen(look) ? look : w);
      if (!isOpen(seg.dataset.on)) setMode(w);
      say(`${opened.map(s => s.toUpperCase()).join(' + ')} OPEN`);
    } else if (closed) {
      flashChange('ROOM CLOSED — NOTHING MORE TO SEND', null);
      say('ROOM CLOSED');
    } else if (changedPrompt) {
      flashChange('NEW INSTRUCTION FROM THE STAGE', look && look !== seg.dataset.on ? look : null);
    }
  }

  // ---------------------------------------------------------------- shared handle inputs
  const handleInputs = [$('#handle'), $('#handle-2'), $('#handle-3')].filter(Boolean);
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
    // `000/280` at rest reads as a broken readout; only surface it near the cap
    counter.hidden = n < 200;
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
      const r = await postJSON('api/submit', { sid, handle: handle || undefined, kind: item.kind, text: item.text });
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
    if (!isOpen('signal')) { showErr(sigErr, 'Signal is not open yet. It opens from the stage.'); return; }
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
  const radarHost = $('#radar-host');
  const radarNote = $('#radar-note');
  const ghostToggle = $('#ghost-toggle');
  const transmitPanel = $('#transmit-panel');
  const transmitBtn = $('#transmit-btn');
  const transmitLabel = $('.send-label', transmitBtn);
  const transmitHint = $('#transmit-hint');
  const asmErr = $('#assemble-error');
  const card = $('#class-card');

  // Ghost reference polygons. Vader et al. are COMPARISONS drawn behind your
  // shape, not endpoints on a scale. 'ghost.room' is the live room aggregate
  // and is excluded here — the phone shows authored references only.
  let showGhosts = lsGet(LS.ghosts, true);
  function ghostSet() {
    // Ghosts are a comparison, so they only mean anything once the user has a
    // shape of their own. The manual toggle was a preference control shown
    // before there was any content to apply it to; it is now automatic.
    if (!showGhosts || !(typeof picks !== 'undefined' && picks.size)) return [];
    return (catalog.ghosts || []).filter(g => g.id !== 'ghost.room');
  }

  const ARCHETYPES = [[0, 'DAILY DESIGNER'], [25, 'RACE CAR DRIVER'], [50, 'PILOT'], [75, 'ASTRONAUT'], [100, 'VADER']];
  const archetypeFor = s => ARCHETYPES.reduce((best, a) => Math.abs(a[0] - s) < Math.abs(best[0] - s) ? a : best)[1];

  // hybrid prefixes when a second group is nearly as dominant
  const PREFIX = { BODY: 'Exo-', SENSES: 'Sensor ', COGNITION: 'Archival ', VOICE: 'Polyglot ', VEHICLE: 'Kinetic ', SOCIAL: 'Networked ', CRAFT: 'Artisan ', LABOR: 'Contracted ', DOMESTIC: 'Hearth ' };

  let catalog = { groups: [], components: [], axes: [], ghosts: [] };
  let byId = new Map();
  let picks = new Set(lsGet(LS.picks, []));
  let openSlots = new Set(lsGet(LS.open, []));

  // AXIS_ORDER is read from the catalog and is FIXED. Radar silhouettes change
  // dramatically with spoke order on identical data — never sort by value.
  let AXIS_ORDER = [];
  // The one derived scalar we keep from the retired 1-D spectrum. Polygons do
  // not aggregate into a single glance as cleanly, so one axis carries that
  // moment. DEPENDENCE is the honest choice: "what breaks if it stops."
  const SCALAR_AXIS = 'DEPENDENCE';

  function compute() {
    const chosen = [...picks].map(id => byId.get(id)).filter(Boolean);
    const n = chosen.length;
    const zero = {};
    for (const ax of AXIS_ORDER) zero[ax] = 0;
    if (!n) return { spectrum: 0, klass: null, n, groups: [], vector: zero };
    // MEAN across picks, never sum. Sum would make more picks = bigger polygon,
    // rebuilding the scoreboard the 1-D spectrum was removed for. Mean makes
    // shape = character; pick COUNT is surfaced as fill density instead.
    const vector = (window.Radar
      ? window.Radar.meanVector(chosen, AXIS_ORDER)
      : zero);
    // retained scalar for the one-glance readout — a real axis, not a ranking
    const spectrum = Math.round(clamp(+vector[SCALAR_AXIS] || 0, 0, 100));
    // group dominance by pick COUNT (v2 has no per-component weight)
    const gc = {};
    for (const c of chosen) gc[c.group] = (gc[c.group] || 0) + 1;
    const groups = Object.entries(gc).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [g1, w1] = groups[0];
    const base = (catalog.groups.find(g => g.id === g1) || {}).klass || 'Steward';
    let klass = base;
    if (groups[1] && groups[1][1] >= 0.8 * w1 && PREFIX[groups[1][0]]) {
      klass = PREFIX[groups[1][0]] + base;
    }
    // qualitative modifiers read off the shape, not off a total score
    if ((+vector.AGENCY || 0) >= 70) klass = 'Dispatched ' + klass;
    else if ((+vector.MASTERY || 0) >= 70) klass = 'Adept ' + klass;
    return { spectrum, klass, n, groups, vector };
  }

  // The single axis a component scores highest on — a compact, honest label for
  // the catalog row. Ties break by the FIXED axis order, never alphabetically,
  // so the readout is stable across renders.
  function dominantAxis(c) {
    const v = (c && c.vector) || {};
    let bestAx = null; let bestVal = -1;
    for (const ax of AXIS_ORDER) {
      const n = +v[ax] || 0;
      if (n > bestVal) { bestVal = n; bestAx = ax; }
    }
    if (!bestAx) return { short: '', title: '' };
    const meta = (catalog.axes || []).find(a => a.id === bestAx) || {};
    return {
      short: `${meta.short || bestAx} ${Math.round(bestVal)}`,
      title: `${meta.label || bestAx}: ${Math.round(bestVal)}/100 — ${meta.desc || ''}`.trim(),
    };
  }

  // The axis desc/lo/hi strings ship in components.v2.json and had no reader.
  // Without them the radar is seven abbreviations nobody in the room can decode.
  function renderAxisKey() {
    const list = document.getElementById('axis-key-list');
    if (!list) return;
    const byId = new Map((catalog.axes || []).map(a => [a.id, a]));
    list.innerHTML = AXIS_ORDER.map((id) => {
      const a = byId.get(id) || {};
      return `
        <li class="axis-key__row">
          <span class="axis-key__name">${a.label || id}</span>
          <span class="axis-key__desc">${a.desc || ''}</span>
          <span class="axis-key__scale">${a.lo || ''} → ${a.hi || ''}</span>
        </li>`;
    }).join('');
  }

  function renderState() {
    const s = compute();
    // Cold-arrival fix: an empty radar + three zero readouts pushed the first
    // tappable component ~750px below the fold. Hide the whole readout block
    // until the user owns some content.
    const sp = document.getElementById('spectrum-panel');
    if (sp) sp.dataset.picks = String(s.n);
    spectrumNum.textContent = pad(s.spectrum);
    picksOut.textContent = pad(s.n, 2);
    klassOut.textContent = s.klass || 'Unassembled';
    klassOut.classList.toggle('is-none', !s.klass);
    // Draw the polygon. pickCount drives fill DENSITY only — never radius, or
    // more picks would mean a bigger shape and we'd be back to a scoreboard.
    if (radarHost && window.Radar && AXIS_ORDER.length) {
      window.Radar.mount(radarHost, {
        vector: s.vector,
        axes: catalog.axes || [],
        axisOrder: AXIS_ORDER,
        ghosts: ghostSet(),
        pickCount: s.n,
        size: 320,
        labels: true,
      });
    }
    if (radarNote) {
      radarNote.textContent = !s.n
        ? 'PICK COMPONENTS TO DRAW YOUR SHAPE'
        : `SHAPE FROM ${pad(s.n, 2)} PICKS · MEAN ACROSS ${AXIS_ORDER.length} AXES`;
    }
    const arch = archetypeFor(s.spectrum);
    transmitBtn.disabled = !s.n || transmitting;
    if (!transmitting) {
      transmitLabel.textContent = sentCard
        ? (cardStale ? 'RE-TRANSMIT' : 'SENT')
        : 'TRANSMIT';
    }
    // Collapse the transmit block once it has done its job. After a clean send
    // it is a receipt, not a call to action, so it drops to a compact state and
    // only re-expands when the picks actually change and there is something new
    // to send. Keeps the vertical budget for the component list.
    const sentClean = !!sentCard && !cardStale && !transmitting;
    transmitPanel.classList.toggle('is-collapsed', sentClean);
    transmitPanel.classList.toggle('is-stale', !!sentCard && !!cardStale);
    transmitHint.textContent = !s.n ? 'TAP ANYTHING BELOW TO START'
      : cardStale ? `UNSENT CHANGES · ${arch} · ${s.klass}`
      : `${arch} · ${s.klass}`;
    transmitHint.classList.toggle('is-stale', !!cardStale && !!s.n);
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
    // ASSEMBLE STAYS EDITABLE ALL TALK: never hide the card, never lock the picks.
    // Editing after a transmit just marks the card STALE until you re-transmit
    // (the server upserts one assemblage per sid, latest wins).
    if (sentCard) { cardStale = true; renderCardStale(); }
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
        // v2 has no scalar `weight`. The honest per-component readout is its
        // DOMINANT AXIS — what this thing mostly does to you — not a 1-5 bar,
        // which was just the retired spectrum leaking into the catalog list.
        const dom = dominantAxis(c);
        const b = el('button', { class: 'comp', type: 'button', 'aria-pressed': String(on), 'data-id': c.id },
          el('span', { class: 'comp-box', 'aria-hidden': 'true' }),
          el('span', { class: 'comp-main' },
            el('span', { class: 'comp-label', text: c.label }),
            el('span', { class: 'comp-blurb', text: c.blurb })),
          el('span', { class: 'comp-axis micro-label', title: dom.title, text: dom.short }),
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
      // components.v2.json — 7-axis vectors. v1 (components.json) was the
      // retired 1-D weight/spectrum catalog; it has no vectors and cannot
      // drive the radar. Do not fall back to it.
      const res = await fetch('components.v2.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      catalog = await res.json();
      // FIXED spoke order straight from the data file — never derived from
      // Object.keys and never sorted by value.
      AXIS_ORDER = (catalog.aggregation && catalog.aggregation.axisOrder)
        || (catalog.axes || []).map(a => a.id);
      renderAxisKey();
      byId = new Map(catalog.components.map(c => [c.id, c]));
      picks = new Set([...picks].filter(id => byId.has(id)));
      buildSlots();
      renderState();
      // a refresh mid-talk must not lose your card — rebuild it from localStorage
      if (sentCard && picks.size) renderCard(compute(), sentCard, { scroll: false });
      syncAssembleAffordances();
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
  // sentCard: has this sid ever transmitted?  cardStale: picks changed since.
  // The card NEVER becomes read-only and NEVER disappears — Marcel's rule.
  let sentCard = lsGet(LS.card, null);
  let cardStale = false;
  const cardEdit = $('#card-edit');
  cardEdit.textContent = 'EDIT MY PICKS';
  cardEdit.classList.add('is-edit-cta');
  // high-signifier stale banner, injected above the card actions
  const cardStaleBar = el('p', { class: 'card-stale micro-label', id: 'card-stale', hidden: true,
    text: 'PICKS CHANGED · RE-TRANSMIT TO UPDATE THE ROOM' });
  card.insertBefore(cardStaleBar, $('.card-actions', card));

  function renderCardStale() {
    cardStaleBar.hidden = !(sentCard && cardStale);
    card.classList.toggle('is-stale', !!(sentCard && cardStale));
    if (typeof catalog === 'object' && catalog.groups && catalog.groups.length) renderState();
  }

  // The assemblage builder is only *offered* when assembleOpen has ever been true.
  // Once offered it is never withdrawn (except an explicit closed beat).
  function syncAssembleAffordances() {
    const open = isOpen('assemble');
    $('#transmit-panel').hidden = !open;
    $('#spectrum-panel').hidden = !open;
    slotsRoot.hidden = !open;
    // the card stays visible whenever it exists — you built it, you keep it
    card.hidden = !lastCard;
    $('#gate-assemble').hidden = open;
    $('#gate-signal').hidden = isOpen('signal');
    $('.signal-form').hidden = !isOpen('signal');
    // hide the empty-state box entirely until they've actually sent something
    $('#mode-signal .log').hidden = !log.length;
  }

  function renderCard(s, r, { scroll = true } = {}) {
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
    if (r && r.id) { sentCard = { id: r.id, ts: r.ts }; lsSet(LS.card, sentCard); cardStale = false; }
    renderCardStale();
    if (scroll) card.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  }

  // Ghost polygons are a comparison layer, so let people turn them off — on a
  // small screen four reference shapes behind yours can bury your own outline.
  if (ghostToggle) {
    ghostToggle.checked = !!showGhosts;
    ghostToggle.addEventListener('change', () => {
      showGhosts = !!ghostToggle.checked;
      lsSet(LS.ghosts, showGhosts);
      renderState();
    });
  }

  transmitBtn.addEventListener('click', async () => {
    if (transmitting) return;
    if (!isOpen('assemble')) { showErr(asmErr, 'Assemble is not open right now.'); return; }
    const s = compute();
    if (!s.n) { showErr(asmErr, 'Pick at least one component first.'); return; }
    hideErr(asmErr);
    
    // Scroll to the radar first to show the assemblage visualization
    radarHost.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    
    transmitting = true;
    transmitBtn.disabled = true;
    transmitBtn.classList.add('is-busy');
    transmitLabel.textContent = 'TRANSMITTING';
    try {
      const r = await postJSON('api/assemblage', { sid, handle: handle || undefined, picks: [...picks], spectrum: s.spectrum, klass: s.klass, vector: s.vector });
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
      setTimeout(() => { renderState(); }, 1600);
    }
  });

  // Way back to editing. The card is NOT dismissed — it stays on screen as the
  // record of what the room currently has for you, while you revise above it.
  cardEdit.addEventListener('click', () => {
    setMode('assemble', { scroll: false });
    const firstSlot = $('.slot', slotsRoot);
    if (firstSlot && !firstSlot.classList.contains('is-open')) $('.slot-head', firstSlot).click();
    // (was: pre-POST scroll to the radar. Two scroll jumps in ~1s on a
    // one-handed phone read as a glitch — renderCard() does the one that matters.)
    say('EDIT YOUR PICKS — RE-TRANSMIT WHEN DONE');
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

  // ================================================================ MODE C: COLLECTIVE
  // Sub-tabs within one mode: STYLE IDEAS (free text -> live feed) and
  // STORY VOTES (existing prompt-piece slots, but voting instead of only submitting).
  const subtabs = [...document.querySelectorAll('.subseg-btn')];
  const submodes = { style: $('#sub-style'), votes: $('#sub-votes') };
  function setSub(name) {
    if (!submodes[name]) name = 'style';
    subtabs.forEach(t => {
      const on = t.id === `subtab-${name}`;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', String(on));
    });
    for (const [k, sec] of Object.entries(submodes)) sec.hidden = k !== name;
  }
  subtabs.forEach(t => t.addEventListener('click', () => setSub(t.id.replace('subtab-', ''))));

  // ---------- STYLE IDEAS ----------
  const styleForm = $('#style-form');
  const styleTa = $('#style-text');
  const styleCounter = $('#style-counter');
  const styleSendBtn = $('#style-send-btn');
  const styleSendLabel = $('.send-label', styleSendBtn);
  const styleErr = $('#style-error');
  const styleFeedList = $('#style-feed-list');
  const styleFeedCount = $('#style-feed-count');
  const STYLE_MAX = 120;
  const seenStyleIds = new Set();
  let styleIdeas = []; // newest last, matches server convention

  function updateStyleCounter() {
    const n = [...styleTa.value].length;
    styleCounter.hidden = n < 80;
    styleCounter.innerHTML = `${pad(n)}<span class="counter-sep">/</span>${STYLE_MAX}`;
    styleCounter.classList.toggle('is-warn', n >= 100 && n < STYLE_MAX);
    styleCounter.classList.toggle('is-danger', n >= STYLE_MAX);
    styleTa.classList.toggle('is-over', n > STYLE_MAX);
    const ok = styleTa.value.trim().length > 0 && n <= STYLE_MAX;
    styleSendBtn.disabled = !ok || styleSending;
  }
  let styleSending = false;
  styleTa.addEventListener('input', () => { hideErr(styleErr); updateStyleCounter(); });
  styleTa.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') styleForm.requestSubmit(); });

  function renderStyleFeed() {
    styleFeedList.replaceChildren();
    styleFeedCount.textContent = pad(styleIdeas.length);
    if (!styleIdeas.length) {
      styleFeedList.append(el('li', { class: 'log-empty micro-label', text: 'NO STYLE IDEAS YET — BE FIRST' }));
      return;
    }
    for (const idea of [...styleIdeas].reverse()) styleFeedList.append(renderStyleItem(idea));
  }
  function renderStyleItem(idea) {
    const t = new Date(idea.ts || Date.now());
    const hh = pad(t.getHours(), 2), mm = pad(t.getMinutes(), 2);
    return el('li', { class: 'log-item is-received', 'data-id': idea.id },
      el('span', { class: 'log-kind', text: '✎', 'aria-label': 'style idea' }),
      el('p', { class: 'log-text', text: idea.text }),
      el('span', { class: 'log-meta micro-label', text: `${hh}:${mm}${idea.handle ? ' · ' + idea.handle : ''}` }),
    );
  }
  function onStyleIdea(idea) {
    if (!idea || seenStyleIds.has(idea.id)) return;
    seenStyleIds.add(idea.id);
    styleIdeas.push(idea);
    styleIdeas = styleIdeas.slice(-12);
    renderStyleFeed();
    if (!reducedMotion) {
      const li = styleFeedList.firstElementChild;
      if (li) { li.classList.add('is-new-pulse'); setTimeout(() => li.classList.remove('is-new-pulse'), 700); }
    }
  }

  styleForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (styleSending) return;
    const text = styleTa.value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
    if (!text) { showErr(styleErr, 'Write something first.'); return; }
    if ([...text].length > STYLE_MAX) { showErr(styleErr, `Over ${STYLE_MAX} characters. Trim it.`); return; }
    hideErr(styleErr);
    styleSending = true;
    styleSendBtn.disabled = true;
    styleSendBtn.classList.add('is-busy');
    styleSendLabel.textContent = 'SENDING';
    try {
      const r = await postJSON('api/style-idea', { sid, handle: handle || undefined, text });
      styleSendLabel.textContent = `RECEIVED · ${r.id}`;
      say(`STYLE IDEA LOGGED · ID ${r.id}`);
      onStyleIdea({ id: r.id, ts: r.ts, sid, handle, text });
      styleTa.value = ''; updateStyleCounter();
    } catch (err) {
      const human = err.status === 429 ? 'Too fast — one submission every 3 seconds (shared with Signal). Retry in a moment.'
        : err.status === 404 ? 'Server endpoint not found (/api/style-idea → 404). Retry when the link is back.'
        : err.status ? `Server refused it: ${err.message}`
        : 'No link to the server. Retry when the link is back.';
      showErr(styleErr, human);
      styleSendLabel.textContent = 'FAILED — RETRY?';
    } finally {
      styleSending = false;
      styleSendBtn.classList.remove('is-busy');
      setTimeout(() => { styleSendLabel.textContent = 'SEND IDEA'; updateStyleCounter(); }, 1400);
      updateStyleCounter();
    }
  });
  updateStyleCounter();

  // ---------- STORY VOTES ----------
  const voteSlotsRoot = $('#vote-slots');
  let promptFormat = { title: '', slots: [] };
  // pieceIndex: id -> { piece, cardEl, votesEl, btnEl } so SSE frames can find
  // and update a specific card wherever it renders, without a full re-render.
  const pieceIndex = new Map();
  let promptPins = { SETTING: null, COMPANION: null, THREAT: null, ARTIFACT: null, TWIST: null };
  let votedByMe = new Set(lsGet('cyborg.votedPieces', []));
  function saveVotedByMe() { lsSet('cyborg.votedPieces', [...votedByMe]); }

  function renderVoteSlots(pieces) {
    voteSlotsRoot.replaceChildren();
    pieceIndex.clear();
    if (!promptFormat.slots.length) {
      voteSlotsRoot.append(el('p', { class: 'micro-label slots-loading', text: 'LOADING SLOTS…' }));
      return;
    }
    for (const slot of promptFormat.slots) {
      const panel = el('section', { class: 'fui-panel vote-slot', id: `vote-slot-${slot.id}` });
      panel.append(el('span', { class: 'fui-corners', 'aria-hidden': 'true' }));
      panel.append(
        el('div', { class: 'vote-slot-head' },
          el('span', { class: 'vote-slot-name display', text: slot.label || slot.id }),
          el('span', { class: 'vote-slot-hint micro-label', text: slot.hint || '' }),
        ),
      );
      const list = el('ul', { class: 'vote-card-list', id: `vote-list-${slot.id}` });
      const arr = (pieces[slot.id] || []).slice().sort((a, b) => (b.votes || 0) - (a.votes || 0) || b.ts - a.ts);
      if (!arr.length) {
        list.append(el('li', { class: 'vote-card-empty micro-label', text: 'NOTHING SUBMITTED YET FOR THIS SLOT' }));
      } else {
        for (const piece of arr) list.append(renderVoteCard(piece, slot.id));
      }
      panel.append(list);
      voteSlotsRoot.append(panel);
    }
  }

  function renderVoteCard(piece, slotId) {
    const pinned = promptPins[slotId] === piece.id;
    const li = el('li', { class: `vote-card${pinned ? ' is-pinned' : ''}`, 'data-id': piece.id, 'data-slot': slotId });
    const main = el('div', { class: 'vote-card-main' },
      pinned ? el('span', { class: 'vote-pin-badge micro-label', text: 'PINNED' }) : null,
      el('p', { class: 'vote-card-text', text: piece.text }),
      el('span', { class: 'vote-card-who micro-label', text: piece.handle ? piece.handle : 'ANON' }),
    );
    const voteBtn = el('button', { class: 'vote-btn', type: 'button', 'aria-label': `Upvote ${piece.text}` },
      el('span', { class: 'vote-btn-arrow', 'aria-hidden': 'true', text: '▲' }),
      el('span', { class: 'vote-btn-count readout', text: pad(piece.votes || 0, 2) }),
    );
    if (votedByMe.has(piece.id)) voteBtn.classList.add('is-voted');
    voteBtn.addEventListener('click', () => castVote(piece.id, slotId, voteBtn));
    li.append(main, voteBtn);
    pieceIndex.set(piece.id, { piece, li, voteBtn, slotId });
    return li;
  }

  async function castVote(id, slotId, btn) {
    const entry = pieceIndex.get(id);
    if (!entry) return;
    // OPTIMISTIC: bump the shown count within 100ms, before the network call resolves.
    const already = votedByMe.has(id);
    const prevVotes = entry.piece.votes || 0;
    if (!already) {
      entry.piece.votes = prevVotes + 1;
      votedByMe.add(id); saveVotedByMe();
      $('.vote-btn-count', btn).textContent = pad(entry.piece.votes, 2);
      btn.classList.add('is-voted', 'is-pending');
    } else {
      // repeat tap on an already-voted card: confirm, don't resend a new optimistic bump
      btn.classList.add('is-pending');
    }
    try {
      const r = await postJSON('api/prompt-vote', { sid, id });
      entry.piece.votes = r.votes;
      $('.vote-btn-count', btn).textContent = pad(r.votes, 2);
      btn.classList.remove('is-pending');
      pulseVote(btn);
    } catch (err) {
      if (err.status === 409 && err.body && typeof err.body.votes === 'number') {
        // already voted server-side — reconcile the count, not an error to show angrily
        entry.piece.votes = err.body.votes;
        $('.vote-btn-count', btn).textContent = pad(err.body.votes, 2);
        btn.classList.remove('is-pending');
        return;
      }
      // real failure: revert the optimistic bump
      if (!already) {
        entry.piece.votes = prevVotes;
        votedByMe.delete(id); saveVotedByMe();
        $('.vote-btn-count', btn).textContent = pad(prevVotes, 2);
        btn.classList.remove('is-voted');
      }
      btn.classList.remove('is-pending');
      say(err.status === 404 ? 'THAT PHRASE IS GONE' : 'VOTE FAILED — NO LINK');
    }
  }

  function pulseVote(btn) {
    if (reducedMotion) return;
    btn.classList.remove('is-pulsing'); void btn.offsetWidth; btn.classList.add('is-pulsing');
    setTimeout(() => btn.classList.remove('is-pulsing'), 400);
  }

  function onPromptVote(data) {
    if (!data || !data.id) return;
    const entry = pieceIndex.get(data.id);
    if (!entry) return; // piece not currently rendered (different slot batch, etc.)
    entry.piece.votes = data.votes;
    $('.vote-btn-count', entry.voteBtn).textContent = pad(data.votes, 2);
    pulseVote(entry.voteBtn);
  }

  function onPromptPin(data) {
    if (!data || !data.slot) return;
    promptPins[data.slot] = data.pinnedId || null;
    // re-render just that slot's list so exactly one card in it shows PINNED
    const list = $(`#vote-list-${data.slot}`);
    if (!list) return;
    const rows = [...pieceIndex.values()].filter(en => en.slotId === data.slot);
    for (const en of rows) {
      const isPinned = promptPins[data.slot] === en.piece.id;
      en.li.classList.toggle('is-pinned', isPinned);
      const badge = $('.vote-pin-badge', en.li);
      if (isPinned && !badge) {
        en.li.querySelector('.vote-card-main').prepend(el('span', { class: 'vote-pin-badge micro-label', text: 'PINNED' }));
      } else if (!isPinned && badge) {
        badge.remove();
      }
    }
  }

  async function loadPromptFormat() {
    const res = await fetch('prompt-format.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`prompt-format.json HTTP ${res.status}`);
    const data = await res.json();
    promptFormat = { title: data.title || '', slots: Array.isArray(data.slots) ? data.slots : [] };
    if (promptFormat.title) $('#vote-format-title').textContent = promptFormat.title.toUpperCase();
  }

  // ================================================================ BOOT
  // 1. paint whatever cue we cached (so a refresh mid-talk isn't a blank beat)
  // 2. GET ./api/state and apply the authoritative cue
  // 3. from then on, live `cue` SSE events drive everything
  applyCue(cue, { initial: true });
  // ---- COLLECTIVE boot: slot copy (static, prompt-format.json) ----
  // Seed data itself (promptPieces/promptVotes/promptPins/styleIdeas) rides
  // on the same GET api/state call bootstrapState() already makes below —
  // one fetch, not a duplicate — see bootstrapState()'s collective block.
  let collectivePiecesSeed = null;
  loadPromptFormat()
    .then(() => { if (collectivePiecesSeed) renderVoteSlots(collectivePiecesSeed); })
    .catch(() => { voteSlotsRoot.replaceChildren(el('p', { class: 'inline-error', role: 'alert', text: 'Slot list failed to load. Reload to retry.' })); });

  booted = true;
  if (pendingCue) { const p = pendingCue; pendingCue = null; onCueFrame(p.c, p.opts); }
  loadCatalog();

  async function bootstrapState() {
    try {
      const res = await fetch('api/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const st = await res.json();
      applyCue(st.cue, { initial: !cue || !cue.beatId });
      // ---- COLLECTIVE seed: prompt pieces (+votes/pins) and style-idea feed ----
      collectivePiecesSeed = st.promptPieces || {};
      promptPins = st.promptPins || promptPins;
      if (promptFormat.slots.length) renderVoteSlots(collectivePiecesSeed);
      if (Array.isArray(st.styleIdeas)) {
        for (const idea of st.styleIdeas) { if (idea && idea.id) seenStyleIds.add(idea.id); }
        styleIdeas = st.styleIdeas.slice(-12);
        renderStyleFeed();
      }
    } catch (e) {
      // visible, not silent: the phone says it doesn't know the beat
      cueBeat.textContent = 'BEAT UNKNOWN — NO LINK';
      cueBar.classList.add('is-stale');
      cuePrompt.textContent = `Couldn't reach the room (${e.message}). Retrying…`;
      cuePrompt.hidden = false;
      setTimeout(bootstrapState, 3000);
    }
  }
  bootstrapState();
  // re-sync on wake: iOS backgrounds the tab and SSE frames get dropped
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') bootstrapState();
  });
})();
