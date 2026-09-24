# CYBORG LIVE — build contract (all agents read this first)

Audience-participation web app for Marcel McVay's two cyborg talks
("You're Already Designing for Cyborgs" panel; "Designing Assemblages" lecture).
Audience opens a URL on their phone. Two primary modes:

  MODE A  SIGNAL  — submit a question / discussion-starter / note in realtime
  MODE B  ASSEMBLE — RPG-style "cyborg assemblage builder": pick the tech that is
                     part of your extended self, get a spectrum position + a class card

A presenter screen (/presenter) shows the live feed + aggregate spectrum.

## Repo layout  (/home/marcel/cyborg-live)

  server.js            Node 18, ZERO npm deps (http, fs, crypto, url only)
  public/
    index.html         audience app (mobile-first, single file OK, may split css/js)
    app.css  app.js
    presenter.html     presenter / big-screen view
    presenter.css presenter.js
    shared.css         design tokens (see below) — both pages import this
  data/
    submissions.jsonl  append-only log (server creates)
    assemblages.jsonl
  cyborg-live.service  systemd --user unit
  README.md

No CDNs. No external fonts at runtime EXCEPT Google Fonts (Space Grotesk, IBM Plex Mono)
which is the one allowed external host. No frameworks. Vanilla ES2020.

## Server: port 8787, plain HTTP, binds 0.0.0.0

Static: serves ./public with correct MIME (html, css, js, json, svg, png, woff2).
`/` -> index.html, `/presenter` -> presenter.html. Cache-Control: no-cache on html.

### Session
Client generates `sid` (crypto.randomUUID) once, stores in localStorage, sends on every POST.
Client also may store a display `handle` (<=24 chars, optional).

### POST /api/submit      body JSON
  { sid, handle?, kind: "question"|"discussion"|"note", text }   text 1..280 chars
  -> 201 { id, ts }
  Rate limit: 1 per 3s per sid -> 429 { error }
  Server strips control chars, trims, rejects empty.

### POST /api/assemblage  body JSON
  { sid, handle?, picks: [componentId...], spectrum: 0..100, klass: string }
  -> 201 { id, ts }
  Upsert semantics: one assemblage per sid (latest wins).

### GET /api/state
  -> { submissions: [...last 200, newest last, hidden ones excluded],
       assemblages: [...one per sid], counts: { question, discussion, note, assemblages },
       spectrumHistogram: [10 buckets], componentTally: { componentId: n } }

### GET /api/feed         Server-Sent Events, text/event-stream
  events:  `submission` (data = submission object)
           `assemblage` (data = assemblage object)
           `moderate`   (data = { id, hidden: true|false })
           `cue`        (data = cue object, incl. `slide`)
           `slide`      (data = { beatId, slide })
           `staged`     (data = { staged })
           `ping` every 20s
  On connect, send nothing historical (client calls /api/state first).

### POST /api/moderate    { id, hidden: bool, key }
  key must equal env ADMIN_KEY (default "cyborg"). -> 200 or 403.
  Presenter UI stores key in localStorage after prompt.

### POST /api/slide       { slide: int 0..199, beatId?, key }
  Sets which slide of the current beat the projector shows.
  -> 200 { ok, beatId, slide } · 400 bad slide · 403 bad key
  -> 409 if beatId is given and does not match the cued beat (stale presenter)

  WHO OWNS SLIDE POSITION: the presenter (/presenter). It is the only surface
  that POSTs here, so the operator drives one interface instead of two. /deck
  is a pure LISTENER — it is unattended on a projector and holds NO admin key,
  so it must never prompt for one and never pushes state upward.

  Deliberately separate from /api/cue: stepping a slide must NOT re-fire the
  beat cue, because the cue carries `ts` and re-firing would reset the beat
  clock mid-beat. A beat cue always resets `slide` to 0; /api/slide leaves
  `cue.ts` untouched.

### Objects
submission = { id, ts, sid, handle, kind, text, hidden:false }
assemblage = { id, ts, sid, handle, picks, spectrum, klass, vector? }
cue        = { beatId, label, mode, prompt, signalOpen, assembleOpen, slide, ts }
id = short random base36 (8 chars). ts = ms epoch.

Persistence: append every event to data/*.jsonl; on boot replay to rebuild state.
Moderation is written as its own line { moderate: id, hidden }.

## Assemblage component catalog  (public/components.json — frontend agent authors it)

Each: { id, label, group, weight, blurb }
groups (RPG "slots"):  BODY (prosthetic/wearable/bio), SENSES (glasses, hearing, camera, GPS),
COGNITION (LLM, search, notes, calendar), VOICE (language, dialect, code, keyboard),
VEHICLE (car, bike, plane, exoskeleton), SOCIAL (feeds, messaging, payments),
CRAFT (Figma, pen, terminal, DAW, guitar).
weight = 1..5 how "obviously" cyborg it is. spectrum = weighted normalised score 0..100.
Spectrum labels (left->right, from Marcel's talk):
  0  DAILY DESIGNER · 25 RACE CAR DRIVER · 50 PILOT · 75 ASTRONAUT · 100 VADER
"klass" = RPG class name derived from dominant group(s), e.g. "Sensor Witch", "Steward",
"Curator", "Linguist", "Exo-Pilot", "Interface Negotiator". Keep them on-theme,
steward/curator/negotiator vocab preferred over user vocab.

Minimum 28 components across 7 groups.

## Design tokens (shared.css) — Marcel's default style x Territory Studio / NASA FUI

  --bg: #0F0F0D;  --fg: #F0EFE9;  --mid: #666666;  --accent: #00E5CC;
  --rule: rgba(240,239,233,0.12);  --warn: #FFB020;  --danger: #FF4D4D;
  font: 'Space Grotesk' for display/headers, 'IBM Plex Mono' for everything else
  (labels, data, buttons, readouts). Uppercase mono micro-labels with letter-spacing .08em.

FUI vocabulary (use, don't overdo): 1px hairline rules, corner brackets on panels,
tick-mark rulers along the spectrum, monospace readouts with leading zeros (007/028),
status pills ("LINK ● LIVE"), thin reticle/crosshair motifs, subtle grid background
(40px, --rule), scanline-free (no cheesy CRT). Motion: 120-200ms ease-out, respect
prefers-reduced-motion. Accent used sparingly for state + live data, never for fills.

## UX primitives (Norman): every control needs signifier, constraint, mapping,
state and feedback as distinct jobs. Touch targets >= 44px. Immediate visual feedback
on every tap (state change within 100ms, before network). Optimistic UI: show the
submission as "SENDING" then "RECEIVED" with id readout. Errors visible inline.

## Success = MVP runs

  node server.js  ->  http://<host>:8787/  and  /presenter  work on iPhone Safari

## PROMPT BUILDER + TERMINAL RPG (added Sep 2026, Miami lecture activity)

New collective-authoring feature: the room submits short phrases into a fixed
set of story "slots" from their phones; a separate ASCII terminal-style text
adventure (think early Zork/MUD) reads the current pool of submitted phrases
and reskins itself live with the room's words. Two new frontend surfaces
consume this; server.js owns the data model and is authored by the parent
session, not a subagent, to avoid two agents fighting over the shared spine.

### Slot catalog: public/prompt-format.json (server does not author content,
only validates the slot IDs below against this file's `id` list at boot)

```json
{
  "version": 1,
  "title": "Build the world together",
  "slots": [
    { "id": "SETTING",   "label": "Setting",   "hint": "Where does this take place?", "placeholder": "a server room that hums in a key nobody can name" },
    { "id": "COMPANION", "label": "Companion", "hint": "What travels with you?",       "placeholder": "a drone that finishes your sentences" },
    { "id": "THREAT",    "label": "Threat",    "hint": "What's hunting the party?",    "placeholder": "an HOA with root access" },
    { "id": "ARTIFACT",  "label": "Artifact",  "hint": "What did you find?",           "placeholder": "a keyboard with one key missing" },
    { "id": "TWIST",     "label": "Twist",     "hint": "What rule breaks here?",       "placeholder": "nobody can lie twice in the same room" }
  ]
}
```

SLOT_IDS is a fixed set matching the `id`s above: SETTING, COMPANION, THREAT,
ARTIFACT, TWIST. Server validates against this literal set (mirrored as a
`Set` in server.js next to `KINDS`/`AXIS_IDS`) — it does NOT read the JSON
file at request time, only static assets read it. If the slot list changes,
update both the JSON (content) and the server's validation set (code) in the
same commit; they must never drift.

### POST /api/prompt-piece    body JSON
  { sid, handle?, slot: one of SLOT_IDS, text }   text 1..60 chars
  -> 201 { id, ts }
  Same cleanText() discipline as /api/submit (strip control chars, trim).
  Rate limit: shares the existing per-sid 3s limiter with /api/submit (one
  combined budget across both endpoints — do not give this its own timer).
  -> 429 { error } on limit, 400 on bad slot/text (400 message must name
  which validation failed: "slot must be one of ..." vs "text required...").

### GET /api/state — extended (existing fields unchanged, this is additive)
  Adds:
    promptPieces: { SETTING: [...], COMPANION: [...], THREAT: [...], ARTIFACT: [...], TWIST: [...] }
      Each slot's array is that slot's own latest 8 pieces, newest LAST
      (same convention as `submissions`), each { id, ts, sid, handle, text }.
    promptCounts: { SETTING: n, COMPANION: n, THREAT: n, ARTIFACT: n, TWIST: n }
      Total ever-submitted count per slot (not capped to 8 — this is the
      tally the builder UI displays, independent of how much history ships).

### GET /api/feed — new SSE event
  `promptpiece`  (data = the new piece object, WITH `slot` included: { id, ts, sid, handle, slot, text })
  Lowercase, one word, matching the existing lowercase event-name convention
  (`submission`, `assemblage`, not `promptPiece` — SSE event names in this
  codebase are all-lowercase nouns; don't introduce camelCase here).

### Persistence
  New log: data/prompt-pieces.jsonl (append-only, same replay-on-boot pattern
  as submissions.jsonl / assemblages.jsonl). Included in reset-room.sh's
  archive-on-reset rotation — reset-room.sh needs a one-line addition to its
  file list, nothing else changes there.

### Objects
  promptPiece = { id, ts, sid, handle, slot, text }

### Who owns which files (disjoint — no two agents touch the same file)

| Owner | Files |
|---|---|
| Parent (this session) | server.js, CONTRACT.md, public/prompt-format.json, reset-room.sh (one-line diff) |
| PROMPT-BUILDER agent | public/promptbuilder.html, promptbuilder.css, promptbuilder.js (new mode on the existing audience app OR standalone page — agent's call, document which) |
| RPG agent | public/rpg.html, rpg.css, rpg.js (new standalone terminal page, projector-and-phone-friendly) |

Both frontend agents READ public/prompt-format.json and GET /api/state /
EventSource /api/feed. Neither WRITES server.js. Both may propose server
contract changes back to the parent rather than editing the file themselves.

### Producer/consumer census (parent verifies before calling this done)

  POST /api/prompt-piece   producer: promptbuilder.js     consumer: server.js
  promptpiece SSE event    producer: server.js             consumer: rpg.js (and optionally promptbuilder.js's own live tally)
  GET promptPieces/state   producer: server.js             consumer: rpg.js, promptbuilder.js

If rpg.js ships without ever calling GET /api/state or subscribing to the
`promptpiece` SSE event, that is the orphaned-endpoint failure this project
already hit once (see autonomous-coding-agents skill,
parallel-file-ownership-decomposition.md) — grep for `promptpiece` and
`api/state` in rpg.js before accepting the build as done.

## COLLECTIVE TAB — style ideas + story voting/pinning (added Sep 2026)

Third tab in the MAIN audience app (index.html/app.js), alongside existing
SIGNAL and ASSEMBLE tabs. Two functions, kept deliberately simple for a live
demo:

1. **STYLE IDEAS** — free-text submissions restyling the space-sandbox
   apps. No slots, no structure — just a text box and a live feed, same
   shape as SIGNAL but a separate stream so it doesn't pollute the Q&A feed.
2. **STORY BUILDER** — reuses the EXISTING prompt-piece slots (SETTING /
   COMPANION / THREAT / ARTIFACT / TWIST, see prompt-format.json above) but
   adds voting: the audience can upvote a phrase someone already submitted
   instead of only ever adding new ones, and Marcel can PIN a winner from
   the presenter side regardless of the vote count — "or just me picking
   and stewarding," per his own framing. rpg.js's slot-picking logic must
   prefer: **pinned > highest-voted > latest > built-in default** for each
   slot, in that order.

### POST /api/style-idea    body JSON
  { sid, handle?, text }   text 1..120 chars (longer cap than prompt-pieces
  — style ideas are more descriptive, e.g. "make it look like a 1970s NASA
  mission patch, orange and cream")
  -> 201 { id, ts }
  Same cleanText() discipline, SAME shared 3s-per-sid rate-limit budget as
  /api/submit and /api/prompt-piece (still one combined limiter, do not add
  a fourth timer).
  -> 400 on empty/oversized text, 429 on rate limit (Retry-After header).

### POST /api/prompt-vote    body JSON
  { sid, id }   id = an existing promptPiece's id (any slot)
  -> 201 { id, votes }   -> 404 if id doesn't exist -> 409 if this sid
  already voted this id (idempotent no-op, NOT an error the UI needs to
  surface loudly — a repeat tap just confirms the vote already landed)
  One vote per sid per piece, tracked server-side in memory (Set per piece,
  NOT persisted as its own log — votes replay from prompt-pieces.jsonl's
  piece objects themselves, see Persistence below). No rate limit on voting
  separate from submission — voting is cheap and shouldn't compete with the
  submission rate-limit budget.

### POST /api/prompt-pin    body JSON   (admin-key gated, presenter-only)
  { key, slot, id }   id = null to CLEAR the pin for that slot
  -> 200 { ok, slot, pinnedId }   -> 403 bad key -> 400 bad slot/id
  Same `requireKey` pattern as /api/cue, /api/moderate, /api/stage. Pin is
  PER SLOT — one pinned piece id per slot, or none.

### GET /api/state — extended again (additive, existing fields unchanged)
  Adds:
    styleIdeas: [...latest 12, newest last, { id, ts, sid, handle, text }]
    styleIdeaCount: n
    promptVotes: { pieceId: n, ... }   vote tally per piece id (only ids
      that have at least 1 vote appear; absent = 0)
    promptPins: { SETTING: id|null, COMPANION: id|null, THREAT: id|null,
      ARTIFACT: id|null, TWIST: id|null }

### GET /api/feed — two new SSE events
  `styleidea`   (data = the new style-idea object)
  `promptvote`  (data = { id, votes } — the piece id and its NEW total)
  `promptpin`   (data = { slot, pinnedId } — pinnedId may be null on clear)
  All lowercase single-word nouns, same convention as existing events.

### Persistence
  New log: data/style-ideas.jsonl (same append-only/replay pattern).
  Votes: NOT their own log. A vote mutates the piece's own record in memory
  (`piece.votes` counter + a `votedBy` Set not serialized). On replay from
  prompt-pieces.jsonl, votes reset to 0 — this is an accepted simplification
  for a live one-night demo, not a durable voting record. If Marcel wants
  votes to survive a server restart mid-talk, that's a follow-up, not v1.
  Pins: NOT their own log either — `state.promptPins` is in-memory only,
  reset on restart. Same accepted simplification. Both reset-room.sh (which
  archives logs, not memory state) and a plain restart already clear pins/
  votes as a side effect; document this as intentional if asked, don't
  "fix" it into a persistence feature nobody requested.

### Objects
  styleIdea = { id, ts, sid, handle, text }
  promptPiece gains one new field: `votes` (number, default 0) — now
  { id, ts, sid, handle, slot, text, votes }

### Who owns which files for this pass (disjoint)

| Owner | Files |
|---|---|
| Parent (this session) | server.js, CONTRACT.md, public/prompt-format.json (unchanged), reset-room.sh (no change needed — logs already covered) |
| COLLECTIVE-TAB agent | public/index.html, app.js, app.css (adds third tab — these are EXISTING files, this agent is editing, not creating; read them fully first, match existing patterns exactly, e.g. `.mode`/`.seg-btn`/`.fui-panel` conventions) |
| RPG-VOTING agent | public/rpg.js (adds pin>voted>latest>default slot-picking logic and a minimal on-screen indicator when a slot's active phrase is audience-voted or presenter-pinned vs. default), AND public/presenter.js + presenter.css (adds a small per-slot PIN control — five buttons/dropdowns, one per slot, showing that slot's current top-voted candidates with a pin/clear action, admin-key gated same as existing presenter controls) |

Neither frontend agent touches server.js. The COLLECTIVE-TAB agent is
editing shared files another surface (SIGNAL/ASSEMBLE tabs) already depends
on — read the FULL current file before changing anything, and do not touch
the SIGNAL or ASSEMBLE tab markup/logic, only add the third tab alongside them.
The RPG-VOTING agent touches TWO files across two different pages
(rpg.js is the projector-side game logic; presenter.js is Marcel's own
control surface) — read both fully before starting, and do not touch any
existing presenter.js control (cue/slide/stage/moderate) while adding pin.

### Producer/consumer census (parent verifies before calling this done)

  POST /api/style-idea    producer: app.js (COLLECTIVE tab)   consumer: server.js
  POST /api/prompt-vote   producer: app.js (COLLECTIVE tab)   consumer: server.js
  POST /api/prompt-pin    producer: presenter.js (new PIN control)   consumer: server.js
  styleidea/promptvote/promptpin SSE events   producer: server.js
    consumer: rpg.js (promptvote/promptpin only — style ideas have no
    reason to reach rpg.js) and optionally app.js's own live tally

Every endpoint in this section needs a real UI producer before this feature
is called done — no exceptions this time, per the standing project rule
after the earlier orphaned-endpoint incident.

## COLLECTIVE is a cued gate (added Sep 24 2026)

COLLECTIVE used to be "always open", which meant nothing ever pointed the
room at it. It is now gated exactly like SIGNAL/ASSEMBLE.

### Cue fields (POST /api/cue, additive)
  collectiveOpen: boolean   same explicit-boolean + ratchet rule as the other
                            two gates. Once open it stays open (except `closed`).
  collectiveFocus: 'style' | 'story' | null
                            lands phones on RESTYLE ('style') or BUILD THE GAME
                            ('story'). A focus CHANGE flashes a banner and
                            switches the phone to the COLLECTIVE tab.

### Slide-level cue (POST /api/slide, additive)
  body.slideCue = { prompt?, collectiveOpen?, collectiveFocus? }
  Authored in the deck as `slide.cue`. presenter.js forwards it verbatim when
  it steps to that slide (and for slide 0 right after a beat cue, since a beat
  cue lands on slide 0 without a slide POST). Only these three fields can
  change; mode/beat identity never does. collectiveOpen can only go true
  (ratchet). If anything changed the server re-broadcasts `cue`.

### New deck slide kinds (deck.js)
  slots   LIVE: the five game blanks with the current winner per slot
          (pinned > top-voted > newest). Repaints on promptpiece/vote/pin.
  game    full-bleed iframe of /rpg (same origin, shares the live room).

### Producers / consumers added
  promptpiece SSE  consumers now: rpg.js, app.js (live cards), deck.js (slots), presenter.js (pin panel)
  styleidea SSE    consumers now: app.js, presenter.js (RESTYLE IDEAS panel, COPY = restyle prompt)
  POST /api/prompt-piece  producers now: promptbuilder.js AND app.js per-slot composer

