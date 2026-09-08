# DECK SCHEMA — frozen contract for cue-driven talks

A deck is **data, not code**: `public/decks/<slug>.json`. Adding, removing, or
reordering beats is a JSON edit. Nothing in `server.js`, `app.js`, or `deck.js`
may reference a beat by array index — only by `id`. This is the whole reason the
running order can change up to five minutes before Marcel walks on stage.

## Top level

```json
{
  "slug": "design-week-ri",
  "title": "You're Already Designing for Cyborgs",
  "venue": "Design Week RI — panel",
  "totalMins": 30,
  "format": "panel",
  "beats": [ ... ]
}
```

`format`: `"panel"` (shared stage, discussion blocks) or `"lecture"` (solo, longer).
Beats with `"panelOnly": true` are skipped by lecture decks.

## Beat

```json
{
  "id": "assemble-open",
  "label": "ASSEMBLE",
  "mins": 3,
  "cue": {
    "mode": "assemble",
    "prompt": "Pick the tech that is genuinely part of you.",
    "signalOpen": false,
    "assembleOpen": true
  },
  "slides": [
    { "kind": "statement", "text": "...", "note": "presenter-only" }
  ],
  "presenterNotes": "What Marcel actually says / does here."
}
```

### `id`
Stable, kebab-case, unique within the deck. Never renumber. Referenced by
`POST /api/cue`. If you delete a beat, its id simply disappears — no reindexing.

### `cue` — what forty phones are allowed to do
Sent verbatim to `POST /api/cue` when the beat is activated. Server validates
`mode` against: `intro`, `assemble`, `reveal`, `present`, `panel`, `steward`, `closed`.

`signalOpen` and `assembleOpen` are **explicit booleans, not implied by mode**.
Two standing rules from Marcel:

1. **SIGNAL opens once and never closes.** Every beat from `reveal` onward MUST
   set `signalOpen: true`. Ambient capture is what makes the panel block work —
   by minute 18 the feed is the material.
2. **ASSEMBLE stays editable all talk.** Every beat from `assemble-open` onward
   MUST set `assembleOpen: true`. People revise after the Regent story; the
   histogram moving live is a feature, not drift.

So the booleans are cumulative once switched on. Never flip either back to false
except in an explicit `closed` beat.

### `slides` — rendered on `/deck` (projector)
Ordered within the beat. `kind` is one of:

| kind | fields | renders as |
|---|---|---|
| `statement` | `text` | full-bleed sentence, Space Grotesk, the money line |
| `quote` | `text`, `attrib` | pull quote with hairline rule + attribution |
| `spectrum` | `labels[]` | the Vader→Daily Designer ruler with tick marks |
| `histogram` | — | LIVE aggregate from `/api/state` (the reveal) |
| `list` | `items[]` | max 4 items, mono, tick-mark bullets |
| `caseStudy` | `title`, `beats[]` | Regent / self-checkout narrative frames |
| `staged` | — | LIVE full-screen audience submission via `/api/stage` |
| `prompt` | `text` | big question + the join URL, for discussion blocks |

Keep it sparse. This is a talk, not a document — if a slide needs a paragraph,
it belongs in `presenterNotes`.

### `presenterNotes`
Shown only on `/presenter`. Plain prose. This is where the vault outline's
detail lives: the exact quote, the story beat, the facilitation move.

## Design tokens
Already defined in `public/shared.css`. Do not introduce new colors.
`--bg #0F0F0D` · `--fg #F0EFE9` · `--mid #666` · `--accent #00E5CC`
Accent is for live state and data only — never fills, never body text.
Deck type scale must read from the back of a room: statement ≥ 4rem.

## Design Week RI running order (locked with Marcel)

| id | mins | mode | notes |
|---|---|---|---|
| `intro` | 0–2 | `intro` | phones out, join URL huge |
| `assemble-open` | 2–5 | `assemble` | everyone builds, zero-risk tap entry |
| `reveal` | 5–7 | `reveal` | room's own histogram is the hook. SIGNAL opens |
| `recognition` | 7–12 | `present` | authorship tension, spectrum |
| `responsibility` | 12–19 | `present` | Regent / Bob Dylan, self-checkout |
| `panel` | 19–27 | `panel` | **panelOnly** — driven off live feed, staged cards |
| `steward` | 27–30 | `steward` | language hack, one-sentence harvest |

Miami is the same engine: no `panel` beat, 40 mins, theory beats expanded
(Clynes & Kline etymology, cybernetics throughline, authentication crisis).
