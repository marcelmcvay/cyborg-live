#!/bin/bash
# smoke test for cyborg-live server. usage: bash smoke.sh [host:port]
H=${1:-localhost:8787}
J='content-type: application/json'
S1=sid-aaaaaaaa-0001; S2=sid-bbbbbbbb-0002
rm -f /tmp/sse.log
(curl -sN --max-time 4 $H/api/feed > /tmp/sse.log &) ; sleep 0.5
echo "submit1: $(curl -s -X POST $H/api/submit -H "$J" -d "{\"sid\":\"$S1\",\"handle\":\"marcel\",\"kind\":\"question\",\"text\":\"is a pilot a cyborg?\"}")"
echo "submit2: $(curl -s -X POST $H/api/submit -H "$J" -d "{\"sid\":\"$S2\",\"kind\":\"discussion\",\"text\":\"language is the first prosthetic\"}")"
echo "ratelim: $(curl -s -o /dev/null -w '%{http_code}' -X POST $H/api/submit -H "$J" -d "{\"sid\":\"$S2\",\"kind\":\"note\",\"text\":\"again\"}")  (expect 429)"
echo "assemb1: $(curl -s -X POST $H/api/assemblage -H "$J" -d "{\"sid\":\"$S1\",\"handle\":\"marcel\",\"picks\":[\"llm\",\"glasses\",\"terminal\"],\"spectrum\":62,\"klass\":\"Sensor Witch\"}")"
echo "assemb1 upsert: $(curl -s -X POST $H/api/assemblage -H "$J" -d "{\"sid\":\"$S1\",\"picks\":[\"exoskeleton\"],\"spectrum\":80,\"klass\":\"Exo-Pilot\"}")"
ID=$(curl -s $H/api/state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).submissions[0].id))')
echo "moderate wrong key: $(curl -s -o /dev/null -w '%{http_code}' -X POST $H/api/moderate -H "$J" -d "{\"id\":\"$ID\",\"hidden\":true,\"key\":\"nope\"}")  (expect 403)"
echo "moderate right key: $(curl -s -o /dev/null -w '%{http_code}' -X POST $H/api/moderate -H "$J" -d "{\"id\":\"$ID\",\"hidden\":true,\"key\":\"${ADMIN_KEY:-cyborg}\"}")  (expect 200)"
# --- slide transport. The presenter owns slide position; /deck only listens.
K="${ADMIN_KEY:-cyborg}"
echo "cue reveal:  $(curl -s -o /dev/null -w '%{http_code}' -X POST $H/api/cue -H "$J" -d "{\"key\":\"$K\",\"beatId\":\"reveal\",\"mode\":\"reveal\",\"signalOpen\":true,\"assembleOpen\":true}")  (expect 200)"
echo "slide 2:     $(curl -s -X POST $H/api/slide -H "$J" -d "{\"key\":\"$K\",\"beatId\":\"reveal\",\"slide\":2}")"
echo "slide badkey: $(curl -s -o /dev/null -w '%{http_code}' -X POST $H/api/slide -H "$J" -d "{\"key\":\"nope\",\"slide\":1}")  (expect 403)"
echo "slide mismatch: $(curl -s -o /dev/null -w '%{http_code}' -X POST $H/api/slide -H "$J" -d "{\"key\":\"$K\",\"beatId\":\"ghost\",\"slide\":1}")  (expect 409)"
echo "slide bad val: $(curl -s -o /dev/null -w '%{http_code}' -X POST $H/api/slide -H "$J" -d "{\"key\":\"$K\",\"slide\":-1}")  (expect 400)"
sleep 4
echo "--- SSE events received (expect submission x2, assemblage x2, moderate):"; grep '^event' /tmp/sse.log
echo "--- state:"; curl -s $H/api/state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log(s.submissions.length,"visible;",JSON.stringify(s.counts),JSON.stringify(s.spectrumHistogram),s.assemblages.map(a=>a.klass))})'
