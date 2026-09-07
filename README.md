# CYBORG LIVE

Audience-participation app for Marcel McVay's cyborg talks. Two modes:
**SIGNAL** (live questions / discussion starters / notes) and **ASSEMBLE**
(RPG-style cyborg assemblage builder → spectrum position + class card).
A presenter view at `/presenter` shows the live feed and aggregate spectrum.

Node 18, zero npm dependencies. Full spec: `CONTRACT.md`.

## Run

```sh
cd /home/marcel/cyborg-live
node server.js                      # http://<host>:8787/  and  /presenter
ADMIN_KEY=secret PORT=9000 node server.js   # override defaults
```

Env: `PORT` (default 8787), `ADMIN_KEY` (default `cyborg`, used by `/api/moderate`).

Data is appended to `data/submissions.jsonl` and `data/assemblages.jsonl`
and replayed on boot. Delete those files to reset the room.

## Run as a systemd --user service

```sh
mkdir -p ~/.config/systemd/user
cp cyborg-live.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cyborg-live     # start now + on login
systemctl --user status cyborg-live
systemctl --user restart cyborg-live
systemctl --user stop cyborg-live
journalctl --user -u cyborg-live -f           # logs
loginctl enable-linger $USER                  # keep running after logout (optional)
```

Edit `Environment=ADMIN_KEY=...` in the unit to change the moderation key,
then `daemon-reload` + `restart`.

## API

| Method | Path              | Body / notes                                                            | Response |
|--------|-------------------|-------------------------------------------------------------------------|----------|
| POST   | `/api/submit`     | `{ sid, handle?, kind: "question"\|"discussion"\|"note", text }` text 1..280; 1 per 3s per sid | `201 { id, ts }`, `429 { error }` |
| POST   | `/api/assemblage` | `{ sid, handle?, picks: [componentId], spectrum: 0..100, klass }` upsert per sid | `201 { id, ts }` |
| GET    | `/api/state`      | —                                                                       | `{ submissions (last 200, hidden excluded), assemblages, counts, spectrumHistogram[10], componentTally }` |
| GET    | `/api/feed`       | Server-Sent Events: `submission`, `assemblage`, `moderate`, `ping` (20s). No history on connect. | `text/event-stream` |
| POST   | `/api/moderate`   | `{ id, hidden: bool, key }` — key must equal `ADMIN_KEY`                | `200 { ok, id, hidden }`, `403 { error }` |
| GET    | `/api/health`     | —                                                                       | `{ ok, uptime, sse }` |

All errors are JSON `{ error: string }`. Bodies capped at 16KB (413). Bad JSON → 400.
CORS `Access-Control-Allow-Origin: *` on everything.

Objects:

```
submission = { id, ts, sid, handle, kind, text, hidden }
assemblage = { id, ts, sid, handle, picks, spectrum, klass }
```

`id` = 8-char base36, `ts` = ms epoch. Moderation is persisted as
`{ moderate: id, hidden, ts }` lines in `submissions.jsonl`.

## Quick test

```sh
curl -s -X POST localhost:8787/api/submit -H 'content-type: application/json' \
  -d '{"sid":"test-sid-0001","kind":"question","text":"hello"}'
curl -s localhost:8787/api/state | head -c 400
curl -N --max-time 25 localhost:8787/api/feed
```
