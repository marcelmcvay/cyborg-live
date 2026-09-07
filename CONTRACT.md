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
           `ping` every 20s
  On connect, send nothing historical (client calls /api/state first).

### POST /api/moderate    { id, hidden: bool, key }
  key must equal env ADMIN_KEY (default "cyborg"). -> 200 or 403.
  Presenter UI stores key in localStorage after prompt.

### Objects
submission = { id, ts, sid, handle, kind, text, hidden:false }
assemblage = { id, ts, sid, handle, picks, spectrum, klass }
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
  and desktop Chrome; SSE feed updates presenter within 1s of a phone submit.
