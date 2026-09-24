/* CYBORG // LIVE — TERMINAL RPG (rpg.js)
   Zero-dependency ASCII text adventure that live-reskins itself from the
   audience "collective prompt builder" (see CONTRACT.md, PROMPT BUILDER +
   TERMINAL RPG). Fully playable with the built-in defaults below; every
   phrase pool blends in real submissions as they arrive over SSE.

   Data flow (per contract):
     1. GET /api/state ONCE on boot to seed promptPieces/promptCounts/promptPins.
     2. EventSource('/api/feed') subscribed to `promptpiece` for every NEW
        piece, `promptvote` for vote tallies, and `promptpin` for the
        presenter's per-slot pin/clear — all three can change which phrase
        currently wins a slot, per the pinned > voted > latest > default
        resolution order (see CONTRACT.md COLLECTIVE TAB section).
*/
(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // 0. Small utilities
  // ---------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const reduceMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Trim + cap a submitted phrase defensively (server already validates
  // length 1..60, this is belt-and-suspenders for anything odd on the wire).
  function cleanPhrase(text) {
    return String(text || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 80);
  }

  // ---------------------------------------------------------------------
  // 1. Slot pools — seeded with defaults, extended live from the backend.
  //    Defaults are the exact placeholder examples from prompt-format.json
  //    so the game is coherent and on-brand before anyone submits anything.
  // ---------------------------------------------------------------------
  const SLOT_IDS = ['SETTING', 'COMPANION', 'THREAT', 'ARTIFACT', 'TWIST'];

  const FALLBACK_DEFAULTS = {
    SETTING: 'a server room that hums in a key nobody can name',
    COMPANION: 'a drone that finishes your sentences',
    THREAT: 'an HOA with root access',
    ARTIFACT: 'a keyboard with one key missing',
    TWIST: 'nobody can lie twice in the same room',
  };

  // pools[slot] = array of { text, source: 'default'|'audience', handle?, votes? }
  const pools = { SETTING: [], COMPANION: [], THREAT: [], ARTIFACT: [], TWIST: [] };

  // Presenter-side pin per slot (see CONTRACT.md COLLECTIVE TAB section):
  // promptPins[slot] = pinned piece id, or null. Seeded from GET /api/state
  // and kept current over the `promptpin` SSE event.
  const promptPins = { SETTING: null, COMPANION: null, THREAT: null, ARTIFACT: null, TWIST: null };

  function seedDefault(slot, text) {
    pools[slot].push({ text: cleanPhrase(text), source: 'default' });
  }

  function pushPiece(slot, piece) {
    if (!pools[slot]) return;
    pools[slot].push({
      text: cleanPhrase(piece.text),
      source: 'audience',
      handle: piece.handle ? cleanPhrase(piece.handle) : null,
      id: piece.id,
      ts: piece.ts,
      votes: Number(piece.votes) || 0,
    });
    // keep pools bounded — mirrors the server's own MAX_PROMPT_PIECES_PER_SLOT
    if (pools[slot].length > 8) pools[slot] = pools[slot].slice(-8);
  }

  // Update the live vote count on whichever piece owns `id`. Returns the
  // slot it was found in (or null) so callers can decide whether the
  // currently-displayed room/phrase needs to be re-resolved.
  function setVotes(id, votes) {
    for (const slot of SLOT_IDS) {
      const piece = pools[slot].find((p) => p.id === id);
      if (piece) {
        piece.votes = Number(votes) || 0;
        return slot;
      }
    }
    return null;
  }

  function setPin(slot, pinnedId) {
    if (!SLOT_IDS.includes(slot)) return;
    promptPins[slot] = pinnedId || null;
  }

  function pinnedPiece(slot) {
    const id = promptPins[slot];
    if (!id) return null;
    return (pools[slot] || []).find((p) => p.id === id) || null;
  }

  function topVoted(slot) {
    const arr = (pools[slot] || []).filter((p) => p.source === 'audience' && (p.votes || 0) > 0);
    if (!arr.length) return null;
    return arr.slice().sort((a, b) => (b.votes || 0) - (a.votes || 0) || (b.ts || 0) - (a.ts || 0))[0];
  }

  // Exactly the old `latest()` behavior — most recent submission wins, or the
  // built-in default if nothing has been submitted yet. Kept as its own
  // function because tier 3 of the resolution order below is defined as
  // "whatever the existing latest-submission-wins logic already does".
  function mostRecent(slot) {
    const arr = pools[slot];
    return arr && arr.length ? arr[arr.length - 1] : { text: FALLBACK_DEFAULTS[slot], source: 'default' };
  }

  // ── Slot resolution: PINNED > HIGHEST-VOTED > LATEST > BUILT-IN DEFAULT ──
  // Per CONTRACT.md COLLECTIVE TAB section: "rpg.js's slot-picking logic
  // must prefer: pinned > highest-voted > latest > built-in default for each
  // slot, in that order." Every caller that used to read `latest(slot)` or
  // `pick(slot, seedIndex)` now gets this resolution instead — the seed-based
  // per-room rotation `pick()` used to do is retired in favor of one
  // steward-able winner per slot, which is the whole point of pinning.
  // `resolved` on the returned object drives the on-screen indicator:
  // 'pinned' | 'voted' | 'audience' (latest submission) | 'default'.
  function latest(slot) {
    const pinned = pinnedPiece(slot);
    if (pinned) return { ...pinned, resolved: 'pinned' };
    const voted = topVoted(slot);
    if (voted) return { ...voted, resolved: 'voted' };
    const rec = mostRecent(slot);
    return { ...rec, resolved: rec.source === 'audience' ? 'audience' : 'default' };
  }

  function pick(slot, seedIndex) {
    void seedIndex; // retired: presenter pin / room vote now decides the single per-slot winner
    return latest(slot);
  }

  // Tiny diagnostic tag for Marcel during a live demo — not audience-facing.
  function slotBadgeText(info) {
    if (!info) return '';
    switch (info.resolved) {
      case 'pinned': return ' [PINNED]';
      case 'voted': return ` [VOTED ${info.votes || 0}]`;
      case 'audience': return ' [LATEST]';
      default: return ' [DEFAULT]';
    }
  }

  function audienceCount(slot) {
    return pools[slot].filter((p) => p.source === 'audience').length;
  }

  // ---------------------------------------------------------------------
  // 2. ASCII art
  // ---------------------------------------------------------------------
  const TITLE_ART = String.raw`
 ▄████▄▓██   ██▓ ▄▄▄▄    ▒█████   ██▀███    ▄████     ██▓     ██▓ ██▒   █▓▓█████
▒██▀ ▀█ ▒██  ██▒▓█████▄ ▒██▒  ██▒▓██ ▒ ██▒ ██▒ ▀█▒   ▓██▒    ▓██▒▓██░   █▒▓█   ▀
▒▓█    ▄ ▒██ ██░▒██▒ ▄██▒██░  ██▒▓██ ░▄█ ▒▒██░▄▄▄░   ▒██░    ▒██▒ ▓██  █▒░▒███
▒▓▓▄ ▄██▒░ ▐██▓░▒██░█▀  ▒██   ██░▒██▀▀█▄  ░▓█  ██▓   ▒██░    ░██░  ▒██ █░░▒▓█  ▄
▒ ▓███▀ ░░ ██▒▓░░▓█  ▀█▓░ ████▓▒░░██▓ ▒██▒░▒▓███▀▒   ░██████▒░██░   ▒▀█░  ░▒████▒
░ ░▒ ▒  ░ ██▒▒▒ ░▒▓███▀▒░ ▒░▒░▒░ ░ ▒▓ ░▒▓░ ░▒   ▒    ░ ▒░▓  ░░▓     ░ ▐░  ░░ ▒░ ░
  ░  ▒  ▓██ ░▒░ ▒░▒   ░   ░ ▒ ▒░   ░▒ ░ ▒░  ░   ░    ░ ░ ▒  ░ ▒ ░   ░ ░░   ░ ░  ░
        `.replace(/\n$/, '');

  const TITLE_ART_SIMPLE = [
    '   ___   _  _  ___  ___  ___    _    _____   __ ',
    '  / __| | || || _ \\| _ \\/ _ \\  | |  |_   _|  \\ \\',
    ' | (__  | __ ||  _/|  _/ (_) | | |__  | |     |  |',
    '  \\___| |_||_||_|  |_|  \\___/  |____| |_|    /  /',
    '                                              /_/',
    '        T E R M I N A L   A D V E N T U R E',
  ].join('\n');

  const ART_SERVER_ROOM = [
    '        ___________________________',
    '       /  [||]  [||]  [||]  [||]   \\',
    '      /___________________________ \\',
    '      | ▒▒ | ▒▒ | ▒▒ | ▒▒ | ▒▒ | ▒▒ |',
    '      | ▒▒ | ▒▒ | ▒▒ | ▒▒ | ▒▒ | ▒▒ |',
    '      |____|____|____|____|____|____|',
    '        hum ......... hum ......... hum',
  ].join('\n');

  const ART_THREAT = [
    '            .-----------.',
    '           /  ___________ \\',
    '          |  | ! WARNING |  |',
    '          |  |___________|  |',
    '           \\_______________/',
    '              |||     |||',
    '            ==(o)=====(o)==',
  ].join('\n');

  const ART_CORE = [
    '         *   .  *      .        *',
    '      .    _____________     .    *',
    '    *    /  ==========   \\    .',
    '        /  |  C O R E  |  \\      *',
    '   .   /___|____________|___\\   .',
    '           ||  ||  ||  ||',
    '      *  .    (the twist waits here)   .  *',
  ].join('\n');

  // ---------------------------------------------------------------------
  // 3. World: rooms, exits, items, NPC
  // ---------------------------------------------------------------------
  const flags = {
    hasTalkedToCompanion: false,
    threatResolved: false,
    twistRevealed: false,
    gameWon: false,
    takenArchive: false,
    takenVent: false,
  };

  const inventory = []; // array of { id, name, desc }

  // Frozen "spawned" item text so an item doesn't visibly retag itself after
  // the player has already read it once this visit (still refreshes if
  // still sitting in the room and a NEW artifact phrase arrives).
  function artifactFlavor(seedIndex) {
    const p = pick('ARTIFACT', seedIndex);
    return {
      text: p.text,
      source: p.source,
      handle: p.handle || null,
      resolved: p.resolved,
      votes: p.votes || 0,
    };
  }

  function settingSentence(seedIndex) {
    const p = pick('SETTING', seedIndex);
    return `You are standing in ${p.text}${slotBadgeText(p)}.`;
  }

  function companionName() {
    const p = latest('COMPANION');
    return `${p.text}${slotBadgeText(p)}`;
  }

  function threatName() {
    const p = latest('THREAT');
    return `${p.text}${slotBadgeText(p)}`;
  }

  function twistText() {
    const p = latest('TWIST');
    return `${p.text}${slotBadgeText(p)}`;
  }

  const rooms = {
    threshold: {
      id: 'threshold',
      title: 'THE THRESHOLD',
      art: null,
      exits: { north: 'corridor' },
      settingSeed: 0,
      describe() {
        return [
          settingSentence(this.settingSeed),
          `A cursor blinks somewhere ahead of you, patient as a held breath.`,
          `A single corridor leads NORTH into the dark.`,
        ].join(' ');
      },
    },
    corridor: {
      id: 'corridor',
      title: 'THE LONG CORRIDOR',
      art: null,
      exits: { north: 'control', east: 'archive', west: 'vent', south: 'threshold' },
      settingSeed: 1,
      describe() {
        return [
          settingSentence(this.settingSeed),
          `Cables snake along the baseboards like something still deciding whether to be alive.`,
          `Exits: NORTH (toward a locked control room), EAST (an archive), WEST (a vent shaft), SOUTH (back to the threshold).`,
        ].join(' ');
      },
    },
    archive: {
      id: 'archive',
      title: 'THE ARCHIVE',
      art: ART_SERVER_ROOM,
      exits: { west: 'corridor' },
      settingSeed: 2,
      itemId: 'archive-item',
      describe() {
        const base = [
          settingSentence(this.settingSeed),
          `Shelves of warm drives tick as they cool.`,
        ];
        if (!flags.takenArchive) {
          const art = artifactFlavor(0);
          const badge = art.source === 'audience' ? ` (submitted by ${art.handle || 'the room'})` : '';
          base.push(`Something sits here you could TAKE: ${art.text}${slotBadgeText(art)}${badge}.`);
        } else {
          base.push(`The shelf where you found something is now empty.`);
        }
        base.push(`Exit: WEST.`);
        return base.join(' ');
      },
    },
    vent: {
      id: 'vent',
      title: 'THE VENT SHAFT',
      art: null,
      exits: { east: 'corridor' },
      settingSeed: 3,
      itemId: 'vent-item',
      describe() {
        const base = [
          settingSentence(this.settingSeed),
          `${escapeHtml('')}`,
        ];
        base[1] = `Something is curled up in here that might be ${companionName()}.`;
        if (!flags.takenVent) {
          const art = artifactFlavor(1);
          const badge = art.source === 'audience' ? ` (submitted by ${art.handle || 'the room'})` : '';
          base.push(`Wedged in the grating you could TAKE: ${art.text}${slotBadgeText(art)}${badge}.`);
        }
        base.push(`Exit: EAST. Try TALK to speak with whatever's in here.`);
        return base.join(' ');
      },
    },
    control: {
      id: 'control',
      title: 'THE CONTROL ROOM',
      art: ART_THREAT,
      exits: { south: 'corridor', north: 'core' },
      settingSeed: 4,
      describe() {
        const base = [settingSentence(this.settingSeed)];
        if (!flags.threatResolved) {
          base.push(
            `You feel hunted by ${threatName()}.`,
            `The north door is sealed until you deal with it. Try USE <item> to defend yourself, or FIGHT / HIDE / RUN.`
          );
        } else {
          base.push(`The threat has moved on, for now. The door NORTH stands open.`);
        }
        base.push(`Exit: SOUTH${flags.threatResolved ? ', NORTH' : ''}.`);
        return base.join(' ');
      },
    },
    core: {
      id: 'core',
      title: 'THE CORE',
      art: ART_CORE,
      exits: { south: 'control' },
      settingSeed: 5,
      describe() {
        const base = [settingSentence(this.settingSeed)];
        if (!flags.twistRevealed) {
          base.push(`Something about this room does not want to be described twice.`);
        } else {
          base.push(`You already know the rule that breaks here.`);
        }
        base.push(`Exit: SOUTH.`);
        return base.join(' ');
      },
    },
  };

  const world = {
    currentRoomId: 'threshold',
    visited: new Set(),
  };

  // ---------------------------------------------------------------------
  // 4. Terminal output
  // ---------------------------------------------------------------------
  const screenLog = $('#screenLog');
  const screenEl = $('#screen');

  function scrollToBottom() {
    screenEl.scrollTop = screenEl.scrollHeight;
  }

  // print raw pre-escaped HTML span line
  function printHtmlLine(html) {
    const span = document.createElement('span');
    span.innerHTML = html + '\n';
    screenLog.appendChild(span);
    scrollToBottom();
  }

  function printLine(text, cls) {
    const safe = escapeHtml(text);
    printHtmlLine(cls ? `<span class="${cls}">${safe}</span>` : safe);
  }

  function printAscii(art) {
    printHtmlLine(`<span class="line-ascii">${escapeHtml(art)}</span>`);
  }

  function printBlank() {
    screenLog.appendChild(document.createTextNode('\n'));
  }

  function printEcho(cmdText) {
    printHtmlLine(`<span class="line-echo">${escapeHtml(cmdText)}</span>`);
  }

  // Typewriter-friendly queued printer (respects prefers-reduced-motion by
  // just printing instantly if reduced motion is requested).
  function printSlow(lines, cls) {
    if (reduceMotion()) {
      lines.forEach((l) => printLine(l, cls));
      return;
    }
    let i = 0;
    function step() {
      if (i >= lines.length) return;
      printLine(lines[i], cls);
      i++;
      setTimeout(step, 90);
    }
    step();
  }

  // ---------------------------------------------------------------------
  // 5. Sidebar rendering
  // ---------------------------------------------------------------------
  const sideCompanion = $('#sideCompanion');
  const sideThreat = $('#sideThreat');
  const sideInventory = $('#sideInventory');
  const sideFeed = $('#sideFeed');
  const feedCounter = $('#feedCounter');

  function renderSidebar() {
    sideCompanion.textContent = companionName();
    sideThreat.textContent = flags.threatResolved
      ? `${threatName()} — neutralized`
      : threatName();

    sideInventory.innerHTML = '';
    if (!inventory.length) {
      const li = document.createElement('li');
      li.className = 'micro-label';
      li.textContent = '(empty)';
      sideInventory.appendChild(li);
    } else {
      inventory.forEach((it) => {
        const li = document.createElement('li');
        li.textContent = it.name;
        sideInventory.appendChild(li);
      });
    }

    const total = SLOT_IDS.reduce((n, s) => n + audienceCount(s), 0);
    feedCounter.textContent = `PHRASES ${String(total).padStart(3, '0')}`;
  }

  function pushFeedItem(slot, text, handle) {
    const li = document.createElement('li');
    li.className = 'is-new';
    const tag = document.createElement('span');
    tag.className = 'feed-slot';
    tag.textContent = slot + (handle ? ` · ${handle}` : '');
    li.appendChild(tag);
    li.appendChild(document.createTextNode(text));
    sideFeed.insertBefore(li, sideFeed.firstChild);
    while (sideFeed.children.length > 8) sideFeed.removeChild(sideFeed.lastChild);
    setTimeout(() => li.classList.remove('is-new'), 4000);
  }

  // ---------------------------------------------------------------------
  // 6. Room rendering / navigation
  // ---------------------------------------------------------------------
  function renderRoom(room, opts) {
    opts = opts || {};
    printBlank();
    printLine(`== ${room.title} ==`, 'line-title');
    if (room.art) printAscii(room.art);
    const desc = room.describe();
    if (opts.slow) {
      printSlow([desc]);
    } else {
      printLine(desc, 'line-room');
    }
    world.visited.add(room.id);
  }

  function goTo(roomId, opts) {
    world.currentRoomId = roomId;
    renderRoom(rooms[roomId], opts);
    renderSidebar();
    maybeTriggerCore(roomId);
  }

  function maybeTriggerCore(roomId) {
    if (roomId === 'core' && !flags.twistRevealed) {
      flags.twistRevealed = true;
      setTimeout(() => {
        printBlank();
        printLine('▓▓▓ THE TWIST ▓▓▓', 'line-warn');
        printSlow([`The rule here is: ${twistText()}.`], 'line-warn');
        setTimeout(() => {
          printBlank();
          printLine(
            'The world resettles around the new rule. You have reached the CORE — the room accepts your presence.',
            'line-dim'
          );
          printLine('Type RESTART to run the adventure again, or keep exploring (SOUTH) to see the space differently now.', 'line-dim');
          flags.gameWon = true;
        }, 700);
      }, 400);
    }
  }

  // ---------------------------------------------------------------------
  // 7. Parser
  // ---------------------------------------------------------------------
  const DIRS = {
    n: 'north', north: 'north',
    s: 'south', south: 'south',
    e: 'east', east: 'east',
    w: 'west', west: 'west',
  };

  function currentRoom() {
    return rooms[world.currentRoomId];
  }

  function roomItem(room) {
    if (!room.itemId) return null;
    if (room.id === 'archive' && flags.takenArchive) return null;
    if (room.id === 'vent' && flags.takenVent) return null;
    return room.itemId;
  }

  function itemDisplayInfo(room) {
    if (room.id === 'archive') return artifactFlavor(0);
    if (room.id === 'vent') return artifactFlavor(1);
    return null;
  }

  function handleTake(argText) {
    const room = currentRoom();
    const itemId = roomItem(room);
    if (!itemId) {
      printLine(`There is nothing here to take.`, 'line-dim');
      return;
    }
    const info = itemDisplayInfo(room);
    const name = info.text;
    inventory.push({ id: itemId, name, desc: `${name}${info.handle ? ` (from ${info.handle})` : ''}` });
    if (room.id === 'archive') flags.takenArchive = true;
    if (room.id === 'vent') flags.takenVent = true;
    printLine(`You take: ${name}.`, 'line-tag');
    renderSidebar();
  }

  function handleExamine(argText) {
    if (!argText) {
      printLine(`Examine what?`, 'line-dim');
      return;
    }
    const needle = argText.toLowerCase();
    const found = inventory.find((it) => it.name.toLowerCase().includes(needle));
    if (found) {
      printLine(`${found.desc}.`, 'line-dim');
      return;
    }
    if ('room'.includes(needle) || 'here'.includes(needle)) {
      printLine(currentRoom().describe(), 'line-dim');
      return;
    }
    printLine(`You don't see "${argText}" here.`, 'line-dim');
  }

  function handleTalk() {
    const room = currentRoom();
    const c = latest('COMPANION');
    if (room.id === 'vent') {
      flags.hasTalkedToCompanion = true;
      printLine(`You crouch down. ${c.text.charAt(0).toUpperCase() + c.text.slice(1)} looks back at you.`, 'line-dim');
      const lines = [
        `"About time," it says, in whatever way it says things.`,
        audienceCount('THREAT')
          ? `"I keep hearing about ${latest('THREAT').text}. Try not to die."`
          : `"Something's hunting us. Try not to die."`,
      ];
      printSlow(lines, 'line-dim');
    } else if (flags.hasTalkedToCompanion) {
      const lines = [
        `${c.text.charAt(0).toUpperCase() + c.text.slice(1)} mutters something you almost catch.`,
      ];
      printSlow(lines, 'line-dim');
    } else {
      printLine(`There's no one here to talk to yet. Try the vent shaft.`, 'line-dim');
    }
  }

  function handleUse(argText) {
    const room = currentRoom();
    if (room.id === 'control' && !flags.threatResolved) {
      if (!argText) {
        printLine(`Use what, against ${threatName()}?`, 'line-warn');
        return;
      }
      const needle = argText.toLowerCase();
      const has = inventory.some((it) => it.name.toLowerCase().includes(needle));
      if (has || inventory.length) {
        resolveThreat();
      } else {
        printLine(`You have nothing like that. Maybe look for something to TAKE first.`, 'line-dim');
      }
      return;
    }
    if (!argText) {
      printLine(`Use what?`, 'line-dim');
      return;
    }
    printLine(`Nothing happens. (Maybe that's for later, or somewhere else.)`, 'line-dim');
  }

  function resolveThreat() {
    flags.threatResolved = true;
    printSlow([
      `You hold your ground against ${threatName()}.`,
      `For now, it backs off. The door NORTH unseals with a click.`,
    ], 'line-tag');
    renderSidebar();
  }

  function handleFightHideRun(verb) {
    const room = currentRoom();
    if (room.id !== 'control' || flags.threatResolved) {
      printLine(`Nothing to ${verb} here right now.`, 'line-dim');
      return;
    }
    if (verb === 'fight') {
      if (inventory.length) {
        resolveThreat();
      } else {
        printLine(`You have nothing to fight with. ${threatName()} is unimpressed. Try TAKE something first, elsewhere.`, 'line-warn');
      }
    } else if (verb === 'hide') {
      printSlow([
        `You hold still. ${threatName()} passes close enough to feel, then loses interest.`,
      ], 'line-tag');
      flags.threatResolved = true;
      renderSidebar();
    } else if (verb === 'run') {
      printLine(`You bolt back SOUTH before ${threatName()} notices you at all.`, 'line-dim');
      goTo('corridor');
    }
  }

  function printHelp() {
    printSlow([
      'Commands: LOOK, GO <direction> (or just NORTH/SOUTH/EAST/WEST/N/S/E/W),',
      'TAKE, EXAMINE <item>, INVENTORY (or INV/I), TALK, USE <item>,',
      'FIGHT / HIDE / RUN (in a threat encounter), RESTART, HELP.',
    ], 'line-dim');
  }

  function printInventory() {
    if (!inventory.length) {
      printLine('You are carrying nothing.', 'line-dim');
      return;
    }
    printLine('You are carrying:', 'line-dim');
    inventory.forEach((it) => printLine(`  - ${it.name}`, 'line-dim'));
  }

  function restartGame() {
    Object.assign(flags, {
      hasTalkedToCompanion: false,
      threatResolved: false,
      twistRevealed: false,
      gameWon: false,
      takenArchive: false,
      takenVent: false,
    });
    inventory.length = 0;
    world.currentRoomId = 'threshold';
    world.visited.clear();
    screenLog.innerHTML = '';
    printTitle();
    goTo('threshold', { slow: true });
  }

  function handleCommand(raw) {
    const text = raw.trim();
    if (!text) return;
    printEcho(text);
    const parts = text.toLowerCase().split(/\s+/);
    let verb = parts[0];
    let rest = parts.slice(1).join(' ');

    // allow bare direction words as the whole command
    if (DIRS[verb] && !rest) {
      verb = 'go';
      rest = DIRS[parts[0]];
    }
    if (verb === 'go' && DIRS[rest]) rest = DIRS[rest];

    switch (verb) {
      case 'look':
      case 'l':
        renderRoom(currentRoom());
        break;
      case 'go':
      case 'move': {
        const dir = DIRS[rest] || rest;
        const room = currentRoom();
        const dest = room.exits[dir];
        if (!dest) {
          printLine(`You can't go ${rest || 'that way'} from here.`, 'line-dim');
        } else {
          goTo(dest);
        }
        break;
      }
      case 'take':
      case 'get':
        handleTake(rest);
        break;
      case 'examine':
      case 'x':
      case 'inspect':
        handleExamine(rest);
        break;
      case 'inventory':
      case 'inv':
      case 'i':
        printInventory();
        break;
      case 'talk':
        handleTalk();
        break;
      case 'use':
        handleUse(rest);
        break;
      case 'fight':
      case 'hide':
      case 'run':
        handleFightHideRun(verb);
        break;
      case 'help':
      case '?':
        printHelp();
        break;
      case 'restart':
        restartGame();
        break;
      default:
        printLine(`I don't understand "${text}". Type HELP for a list of commands.`, 'line-dim');
    }
  }

  // ---------------------------------------------------------------------
  // 8. Title screen
  // ---------------------------------------------------------------------
  function printTitle() {
    printAscii(TITLE_ART_SIMPLE);
    printBlank();
    printLine('A live text adventure, reskinned in realtime by this room\'s own words.', 'line-dim');
    printLine('Submit phrases at the Prompt Builder companion page and watch the world change.', 'line-dim');
    printLine('Type HELP for commands.', 'line-dim');
  }

  // ---------------------------------------------------------------------
  // 9. Verb buttons + form wiring
  // ---------------------------------------------------------------------
  const cmdForm = $('#cmdForm');
  const cmdInput = $('#cmdInput');

  cmdForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = cmdInput.value;
    cmdInput.value = '';
    handleCommand(v);
  });

  document.querySelectorAll('.rpg-verb-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleCommand(btn.dataset.cmd);
      cmdInput.focus();
    });
  });

  // ---------------------------------------------------------------------
  // 10. Backend wiring: seed via /api/state, then live via SSE `promptpiece`
  // ---------------------------------------------------------------------
  const linkPill = $('#linkPill');
  const linkPillLabel = $('#linkPillLabel');

  function setLinkStatus(mode) {
    linkPill.classList.remove('is-live', 'is-warn', 'is-danger');
    if (mode === 'live') {
      linkPill.classList.add('is-live');
      linkPillLabel.textContent = 'LINK ● LIVE';
    } else if (mode === 'connecting') {
      linkPill.classList.add('is-warn');
      linkPillLabel.textContent = 'CONNECTING';
    } else {
      linkPill.classList.add('is-danger');
      linkPillLabel.textContent = 'OFFLINE (LOCAL DEFAULTS)';
    }
  }

  function seedAllDefaults() {
    SLOT_IDS.forEach((slot) => seedDefault(slot, FALLBACK_DEFAULTS[slot]));
  }

  async function loadPromptFormat() {
    try {
      const res = await fetch('prompt-format.json', { cache: 'no-cache' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.slots)) {
        data.slots.forEach((s) => {
          if (SLOT_IDS.includes(s.id) && s.placeholder) {
            FALLBACK_DEFAULTS[s.id] = s.placeholder;
          }
        });
      }
    } catch (err) {
      // fine — hardcoded fallback defaults above already match the shipped file
      console.warn('[rpg] could not load prompt-format.json, using built-in defaults', err);
    }
  }

  // Fetch current state ONCE on load to seed initial world with whatever's
  // already been submitted before this page opened. See CONTRACT.md:
  // GET /api/state -> promptPieces / promptCounts / promptPins.
  async function loadInitialState() {
    try {
      const res = await fetch('/api/state', { cache: 'no-cache' });
      if (!res.ok) throw new Error('bad status ' + res.status);
      const data = await res.json();
      if (data && data.promptPieces) {
        SLOT_IDS.forEach((slot) => {
          const arr = data.promptPieces[slot];
          if (Array.isArray(arr)) {
            arr.forEach((piece) => pushPiece(slot, piece));
          }
        });
      }
      if (data && data.promptPins && typeof data.promptPins === 'object') {
        SLOT_IDS.forEach((slot) => setPin(slot, data.promptPins[slot] || null));
      }
      return true;
    } catch (err) {
      console.warn('[rpg] /api/state fetch failed, running on local defaults only', err);
      return false;
    }
  }

  // Subscribe to live updates. MANDATORY per contract: without this the
  // page only ever reflects a single snapshot at load time, which is the
  // orphaned-endpoint failure mode CONTRACT.md explicitly calls out.
  function subscribeToFeed() {
    if (typeof EventSource === 'undefined') {
      setLinkStatus('offline');
      return;
    }
    setLinkStatus('connecting');
    let es;
    try {
      es = new EventSource('/api/feed');
    } catch (err) {
      setLinkStatus('offline');
      return;
    }

    es.addEventListener('open', () => setLinkStatus('live'));

    // THE live-reskin hook: server emits `promptpiece` (lowercase, one word)
    // per CONTRACT.md's SSE event-naming convention.
    es.addEventListener('promptpiece', (evt) => {
      let piece;
      try {
        piece = JSON.parse(evt.data);
      } catch (err) {
        return;
      }
      if (!piece || !piece.slot || !SLOT_IDS.includes(piece.slot)) return;
      onNewPromptPiece(piece);
    });

    // Vote landed on some piece somewhere — a piece already in a pool may
    // just have overtaken the current slot winner (pinned > VOTED > latest
    // > default), so re-resolve that slot and re-render the room exactly
    // like a new piece would (same in-world "shivers and resettles" beat).
    es.addEventListener('promptvote', (evt) => {
      let d;
      try {
        d = JSON.parse(evt.data);
      } catch (err) {
        return;
      }
      if (!d || !d.id) return;
      const slot = setVotes(d.id, d.votes);
      if (slot) onSlotResolutionChanged(slot);
    });

    // Presenter pinned or cleared a pin for a slot — same re-resolution path.
    es.addEventListener('promptpin', (evt) => {
      let d;
      try {
        d = JSON.parse(evt.data);
      } catch (err) {
        return;
      }
      if (!d || !d.slot || !SLOT_IDS.includes(d.slot)) return;
      setPin(d.slot, d.pinnedId || null);
      onSlotResolutionChanged(d.slot);
    });

    es.addEventListener('ping', () => {
      // keepalive only — no UI action needed, but confirms the link is alive
      setLinkStatus('live');
    });

    es.onerror = () => {
      setLinkStatus('offline');
    };
  }

  function onNewPromptPiece(piece) {
    pushPiece(piece.slot, piece);
    const text = cleanPhrase(piece.text);
    const handle = piece.handle ? cleanPhrase(piece.handle) : null;
    pushFeedItem(piece.slot, text, handle);
    renderSidebar();

    // Announce the reskin in-world, then refresh the room if it's affected.
    printBlank();
    printLine(
      `~~~ SIGNAL: new ${piece.slot} phrase received${handle ? ` from ${handle}` : ''} ~~~`,
      'line-tag'
    );

    reresolveSlotInWorld(piece.slot);
  }

  // Shared re-render path for anything that can change WHICH phrase currently
  // wins a slot (a new submission, a vote overtaking the leader, or Marcel
  // pinning/clearing a slot from the presenter screen). Reuses the exact
  // "room shivers and resettles" behavior onNewPromptPiece already used for
  // new pieces, so all three triggers feel consistent in-world.
  function onSlotResolutionChanged(slot) {
    renderSidebar();
    reresolveSlotInWorld(slot);
  }

  function reresolveSlotInWorld(slot) {
    const room = currentRoom();
    let touchesRoom = false;
    if (slot === 'SETTING') touchesRoom = true;
    if (slot === 'COMPANION' && room.id === 'vent') touchesRoom = true;
    if (slot === 'THREAT' && room.id === 'control' && !flags.threatResolved) touchesRoom = true;
    if (slot === 'ARTIFACT' && (room.id === 'archive' || room.id === 'vent')) touchesRoom = true;
    if (slot === 'TWIST' && room.id === 'core' && !flags.twistRevealed) touchesRoom = true;

    if (touchesRoom) {
      printLine('The room around you shivers and resettles slightly.', 'line-dim');
      renderRoom(room);
    }
  }

  // ---------------------------------------------------------------------
  // 11. Boot
  // ---------------------------------------------------------------------
  async function boot() {
    seedAllDefaults();
    await loadPromptFormat();
    // re-seed defaults now that we may have real placeholders from the file
    SLOT_IDS.forEach((slot) => {
      if (pools[slot].length === 1 && pools[slot][0].source === 'default') {
        pools[slot][0].text = cleanPhrase(FALLBACK_DEFAULTS[slot]);
      }
    });

    printTitle();
    await loadInitialState();
    renderSidebar();
    goTo('threshold', { slow: true });
    subscribeToFeed();
    cmdInput.focus();
  }

  boot();
})();
