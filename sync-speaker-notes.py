#!/usr/bin/env python3
"""
Sync speaker notes from Obsidian -> cyborg-live deck JSON.

  python3 sync-speaker-notes.py --check   # parse + report, write nothing
  python3 sync-speaker-notes.py           # apply (writes .bak first)

PARSER RULES (these encode two bugs that corrupted the deck once; do not relax them)

1. Headings are matched ONLY at the start of a line ('^### Slide', MULTILINE) and
   never with re.DOTALL. A heading indented inside a callout ('> ### Slide') is
   CONTENT, not structure. Collapsing several slides' notes into one callout is a
   legitimate authoring move (the lobby auto-advances), so nested headings must be
   preserved verbatim, never re-promoted into new slides.

2. Callout lines are stripped with a rule that handles the bare '>' terminator.
   '> text' -> 'text', and a lone '>' -> '' (NOT '>'). The naive
   `line[2:] if line.startswith('> ')` leaves a literal '>' welded to the note.

3. Slides are keyed by their number in the heading, not by enumeration order, so a
   beat whose notes are deliberately collapsed does not shift every later slide.

4. COLLAPSED BEATS. Authoring style is to draft a beat's whole run inside slide 1's
   callout, which leaves each sibling note existing twice (once nested in slide 1,
   once on its own slide) and makes the presenter panel repeat on advance. Policy:

     - COLLAPSED_BEATS (auto-advancing, never hand-clicked): slide 1 keeps the full
       collapsed run; sibling notes are CLEARED so the text lives in one place.
     - every other beat: slide 1 is TRIMMED at its first nested heading and each
       sibling keeps its own note.

   Trimming only ever removes text that is provably duplicated on a sibling slide
   (compared under NFKC + curly-quote normalisation -- a raw compare yields false
   negatives because Obsidian rewrites ' as \u2019). Anything not matched is left alone.
"""

import argparse
import json
import re
import shutil
import sys
import unicodedata
from pathlib import Path

NOTES_FILE = Path("/home/marcel/obsidian-vault/CYBORG LIVE/Design Week RI — Speaker Notes.md")
DECK_FILE = Path("/home/marcel/cyborg-live/public/decks/design-week-ri.json")

BEAT_RE = re.compile(r'^## (.+?) \((\d+) min\)\s*$', re.MULTILINE)
SLIDE_RE = re.compile(r'^### Slide (\d+) \(([^)]*)\)\s*$', re.MULTILINE)
CALLOUT_RE = re.compile(r'^> \[!(note|quote)\][^\n]*\n((?:>.*\n?)*)', re.MULTILINE)

LABEL_TO_ID = {
    'LOBBY': 'lobby',
    'OPENER': 'intro',
    'CYBERNETICS': 'cybernetics',
    'TURING': 'turing',
    'REVEAL': 'reveal',
    "THE PEOPLE'S SIDEWALKS": 'reshaped',
    'THE PEOPLE\u2019S SIDEWALKS': 'reshaped',
    'RESPONSIBILITY': 'responsibility',
    'RESOLUTION': 'resolution',
    'PANEL': 'panel',
}

# Auto-advancing / feed-driven beats: never hand-clicked slide by slide, so the
# whole run belongs on slide 1 and sibling notes are redundant.
COLLAPSED_BEATS = {'lobby', 'panel'}


def norm(text: str) -> str:
    """NFKC + curly-quote fold + whitespace collapse, for duplicate detection.

    Obsidian rewrites ' as \u2019 and " as \u201c\u201d, so a raw `in` test reports False on
    text that is word-for-word identical. Normalising first is what makes the
    'is this sibling note already inside slide 1' check trustworthy.
    """
    t = unicodedata.normalize('NFKC', text or '')
    for a, b in (('\u2019', "'"), ('\u2018', "'"), ('\u201c', '"'), ('\u201d', '"'), ('\u2014', '-')):
        t = t.replace(a, b)
    return re.sub(r'\s+', ' ', t).strip()


def resolve_collapsed(beat_id: str, slides: dict[int, str]) -> tuple[dict[int, str], list[str]]:
    """Apply the one-place-only policy. Returns (slides, human-readable actions)."""
    first = slides.get(0)
    head = re.search(r'^### Slide', first, re.MULTILINE) if first else None
    if not first or head is None:
        return slides, []

    out, actions = dict(slides), []
    dupes = [i for i, n in slides.items()
             if i != 0 and n and norm(n) and norm(n) in norm(first)]

    if beat_id in COLLAPSED_BEATS:
        for i in sorted(dupes):
            out[i] = ''
        actions.append(f'collapsed: slide 1 keeps full run, cleared {len(dupes)} sibling note(s)')
    else:
        kept, dropped = first[:head.start()].strip(), first[head.start():]
        # Only trim what is provably duplicated on a sibling. Match by CONTENT, not
        # by the heading's slide number -- inserting a slide into the deck makes the
        # note's numbering stale while the prose still corresponds exactly.
        orphan = []
        for m in re.finditer(r'^### Slide (\d+) \([^)]*\)\s*$', dropped, re.MULTILINE):
            seg = dropped[m.end():]
            nxt = re.search(r'^### Slide \d+ \(', seg, re.MULTILINE)
            body = (seg[:nxt.start()] if nxt else seg)
            body = body.split('Slide Notes')[-1]
            body_n = norm(body)
            if not body_n:
                continue
            if not any(body_n in norm(n) or norm(n) in body_n
                       for i, n in slides.items() if i != 0 and n):
                orphan.append(m.group(1))
        if orphan:
            actions.append(f'WARN slide 1 tail references slide(s) {orphan} with no '
                           f'duplicate sibling - left untrimmed for review')
        elif kept:
            out[0] = kept
            actions.append(f'trimmed slide 1 to its own note ({len(dupes)} sibling(s) '
                           f'keep theirs)')
    return out, actions


def strip_callout(block: str) -> str:
    """'> text' -> 'text'; a lone '>' -> ''. Preserves nested '> ### Slide' as content."""
    out = []
    for line in block.split('\n'):
        if line.startswith('> '):
            out.append(line[2:])
        elif line == '>':
            out.append('')
        elif line.strip() == '':
            continue
        else:
            out.append(line)
    return '\n'.join(out).strip()


def first_callout(segment: str, kind: str) -> str | None:
    for m in CALLOUT_RE.finditer(segment):
        if m.group(1) == kind:
            return strip_callout(m.group(2))
    return None


def parse(md: str) -> dict:
    beats, bounds = {}, [(m.start(), m.end(), m.group(1).strip()) for m in BEAT_RE.finditer(md)]
    for i, (_, end, label) in enumerate(bounds):
        stop = bounds[i + 1][0] if i + 1 < len(bounds) else len(md)
        body = md[end:stop]

        slide_hits = list(SLIDE_RE.finditer(body))
        head = body[:slide_hits[0].start()] if slide_hits else body

        slides = {}
        for j, sm in enumerate(slide_hits):
            s_stop = slide_hits[j + 1].start() if j + 1 < len(slide_hits) else len(body)
            note = first_callout(body[sm.end():s_stop], 'quote')
            if note:
                slides[int(sm.group(1)) - 1] = note

        beats[label] = {'presenter': first_callout(head, 'note'), 'slides': slides}
    return beats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='parse and report, write nothing')
    args = ap.parse_args()

    if not NOTES_FILE.exists() or not DECK_FILE.exists():
        print('missing notes or deck file', file=sys.stderr)
        return 1

    parsed = parse(NOTES_FILE.read_text())
    deck = json.loads(DECK_FILE.read_text())

    print(f'parsed {len(parsed)} beats from Obsidian')

    changes, problems = [], []
    for beat in deck['beats']:
        label = next((lab for lab, bid in LABEL_TO_ID.items()
                      if bid == beat['id'] and lab in parsed), None)
        if not label:
            problems.append(f"beat '{beat['id']}' has no matching section in the note")
            continue

        src = parsed[label]
        if src['presenter'] and src['presenter'] != beat.get('presenterNotes'):
            changes.append(f"{beat['id']}: presenterNotes")
            if not args.check:
                beat['presenterNotes'] = src['presenter']

        resolved, actions = resolve_collapsed(beat['id'], src['slides'])
        for a in actions:
            print(f"  {beat['id']}: {a}")
            if a.startswith('WARN'):
                problems.append(f"{beat['id']}: {a}")

        for idx, note in resolved.items():
            if idx >= len(beat.get('slides', [])):
                problems.append(f"{beat['id']}: note for slide {idx+1} but beat has "
                                f"{len(beat.get('slides', []))} slides")
                continue
            if note != beat['slides'][idx].get('note', ''):
                changes.append(f"{beat['id']}: slide {idx+1}"
                               + (' (cleared)' if not note else ''))
                if not args.check:
                    beat['slides'][idx]['note'] = note

    # Guard: a structural heading may only survive in a COLLAPSED_BEATS slide 1,
    # where it is deliberate authoring. Anywhere else it is the corruption bug.
    bad = [f"{b['id']}#{i+1}" for b in deck['beats']
           for i, s in enumerate(b.get('slides', []))
           if re.search(r'^### Slide', s.get('note', ''), re.MULTILINE)
           and not (b['id'] in COLLAPSED_BEATS and i == 0)]
    if bad:
        print('ABORT: structural heading leaked into note text: ' + ', '.join(bad), file=sys.stderr)
        return 2

    for p in problems:
        print(f'  warn: {p}')
    print(f'{len(changes)} note(s) {"would change" if args.check else "changed"}')
    for c in changes[:20]:
        print(f'  - {c}')
    if len(changes) > 20:
        print(f'  ... and {len(changes)-20} more')

    if args.check:
        print('\n--check: nothing written')
        return 0

    shutil.copy(DECK_FILE, DECK_FILE.with_suffix('.json.bak'))
    DECK_FILE.write_text(json.dumps(deck, indent=2, ensure_ascii=False) + '\n')
    print(f'wrote {DECK_FILE} (backup: {DECK_FILE.name}.bak)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
