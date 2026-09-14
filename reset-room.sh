#!/usr/bin/env bash
# Clear the room before a talk: wipe signals + assemblages, start a fresh session.
#
#   ./reset-room.sh                     # status only, changes nothing
#   ./reset-room.sh "DESIGN WEEK RI"    # archive + clear + name the new session
#
# Logs are ARCHIVED with a timestamp, never deleted -- data/*.TIMESTAMP.jsonl.
# ADMIN_KEY must match the server's (default 'cyborg'); the key goes in the JSON
# BODY as `key`, not a header.
set -euo pipefail

HOST="${HOST:-http://127.0.0.1:8787}"
KEY="${ADMIN_KEY:-cyborg}"

state() {
  curl -fsS --max-time 5 "$HOST/api/state" | python3 -c '
import json,sys
d = json.load(sys.stdin)
sess = d.get("session", {}).get("label", "?")
cue  = d.get("cue", {}).get("beatId", "?")
print("  signals     :", len(d["submissions"]))
print("  assemblages :", len(d["assemblages"]))
print("  session     :", sess)
print("  cue         :", cue)'
}

if ! curl -fsS --max-time 5 "$HOST/api/health" >/dev/null 2>&1; then
  echo "ERROR: no server at $HOST" >&2
  echo "  systemctl --user status cyborg-live.service" >&2
  exit 1
fi

echo "CURRENT:"; state

if [ $# -eq 0 ]; then
  echo
  echo "Status only — nothing changed."
  echo "To clear:  ./reset-room.sh \"DESIGN WEEK RI\""
  exit 0
fi

LABEL="$1"
echo
read -r -p "Clear all signals + assemblages, start \"$LABEL\"? [y/N] " ok
[[ "$ok" =~ ^[Yy]$ ]] || { echo "aborted"; exit 0; }

RESP=$(curl -fsS --max-time 10 -X POST "$HOST/api/reset" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"key":sys.argv[1],"label":sys.argv[2]}))' "$KEY" "$LABEL")")

echo "$RESP" | python3 -c '
import json,sys
r = json.load(sys.stdin)
if not r.get("ok"):
    print("RESET FAILED:", r)
    raise SystemExit(1)
s = r["session"]
print()
print("RESET OK ->", s["label"], "(session #%d)" % s["n"])
a = r.get("archived", [])
print("archived %d log(s):" % len(a))
for f in a:
    print("   ", f)'

echo
echo "NOW:"; state
echo
echo "Phones reconnect automatically. Hard-refresh the projector if it was open."
