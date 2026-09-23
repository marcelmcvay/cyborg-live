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
