#!/usr/bin/env python3
"""
Sync speaker notes from Obsidian back to cyborg-live deck.

Usage:
  python3 sync-speaker-notes.py

Reads the notes from Obsidian vault and updates the JSON deck.
"""

import json
import re
from pathlib import Path

# Paths
VAULT_PATH = Path("/home/marcel/obsidian-vault")
NOTES_FILE = VAULT_PATH / "CYBORG LIVE" / "Design Week RI — Speaker Notes.md"
DECK_FILE = Path("/home/marcel/cyborg-live/public/decks/design-week-ri.json")

def parse_speaker_notes(content):
    """Parse the Obsidian markdown file and extract speaker notes."""
    
    # Split into sections by ## headers (beats)
    beat_sections = re.split(r'^## (.+) \((\d+) min\)', content, flags=re.MULTILINE)
    
    # First element is header content, ignore it
    beat_sections = beat_sections[1:]
    
    beats = {}
    
    # Process in groups of 3: beat_title, duration, content
    for i in range(0, len(beat_sections), 3):
        if i + 2 >= len(beat_sections):
            break
            
        beat_title = beat_sections[i]
        duration = beat_sections[i + 1]
        beat_content = beat_sections[i + 2]
        
        # Extract presenter notes (in first callout)
        presenter_match = re.search(r'> \[!note\] Presenter Notes\n((?:> .*\n)*)', beat_content)
        presenter_notes = ""
        if presenter_match:
            lines = presenter_match.group(1).split('\n')
            # Remove "> " prefix and rejoin
            presenter_lines = [line[2:] if line.startswith('> ') else line for line in lines if line.strip()]
            presenter_notes = '\n'.join(presenter_lines).strip()
        
        # Extract slide notes
        slide_matches = re.finditer(r'### Slide (\d+) \([^)]+\).*?> \[!quote\] Slide Notes\n((?:> .*\n)*)', beat_content, re.DOTALL)
        slide_notes = {}
        
        for slide_match in slide_matches:
            slide_num = int(slide_match.group(1)) - 1  # 0-indexed
            lines = slide_match.group(2).split('\n')
            # Remove "> " prefix and rejoin
            note_lines = [line[2:] if line.startswith('> ') else line for line in lines if line.strip()]
            slide_note = '\n'.join(note_lines).strip()
            slide_notes[slide_num] = slide_note
        
        beats[beat_title] = {
            'presenter_notes': presenter_notes,
            'slide_notes': slide_notes
        }
    
    return beats

def update_deck_with_notes(deck, parsed_notes):
    """Update the deck JSON with parsed notes."""
    
    # Map beat titles to beat IDs (approximate matching)
    title_to_id = {
        'LOBBY': 'lobby',
        'OPENER': 'intro', 
        'CYBERNETICS': 'cybernetics',
        'TURING': 'turing',
        'REVEAL': 'reveal',
        'THE PEOPLE\'S SIDEWALKS': 'reshaped',
        'RESPONSIBILITY': 'responsibility',
        'RESOLUTION': 'resolution',
        'PANEL': 'panel'
    }
    
    for beat in deck['beats']:
        beat_title = None
        for title, beat_id in title_to_id.items():
            if beat['id'] == beat_id:
                beat_title = title
                break
        
        if beat_title in parsed_notes:
            notes = parsed_notes[beat_title]
            
            # Update presenter notes
            if notes['presenter_notes']:
                beat['presenterNotes'] = notes['presenter_notes']
            
            # Update slide notes
            if 'slides' in beat:
                for slide_idx, slide in enumerate(beat['slides']):
                    if slide_idx in notes['slide_notes']:
                        slide['note'] = notes['slide_notes'][slide_idx]
    
    return deck

def main():
    print("🔄 Syncing speaker notes from Obsidian to cyborg-live...")
    
    # Check if files exist
    if not NOTES_FILE.exists():
        print(f"❌ Notes file not found: {NOTES_FILE}")
        return 1
    
    if not DECK_FILE.exists():
        print(f"❌ Deck file not found: {DECK_FILE}")
        return 1
    
    # Read the notes
    print(f"📖 Reading notes from {NOTES_FILE}")
    with open(NOTES_FILE, 'r') as f:
        notes_content = f.read()
    
    # Parse notes
    parsed_notes = parse_speaker_notes(notes_content)
    print(f"📝 Parsed {len(parsed_notes)} beat sections")
    
    # Read the deck
    print(f"📖 Reading deck from {DECK_FILE}")
    with open(DECK_FILE, 'r') as f:
        deck = json.load(f)
    
    # Update deck
    updated_deck = update_deck_with_notes(deck, parsed_notes)
    
    # Write back
    print(f"💾 Writing updated deck to {DECK_FILE}")
    with open(DECK_FILE, 'w') as f:
        json.dump(updated_deck, f, indent=2)
    
    print("✅ Sync complete!")
    return 0

if __name__ == "__main__":
    exit(main())