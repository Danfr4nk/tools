# sc2mp3

Paste a SoundCloud URL, get an MP3. Tracks and sets/playlists both work.

## Run it

```bash
pip install yt-dlp        # plus ffmpeg however your OS does it
python3 server.py
```

It serves itself at `http://127.0.0.1:8765` and opens your browser. The same
`index.html` is also deployed on the tools site — it talks to the local
server, so the backend still has to be running.

## How it works

- `server.py` — stdlib-only Python backend (no Flask, no pip deps beyond
  `yt-dlp` + `ffmpeg`). Serves the page and exposes `/api/*`:
  - `POST /api/resolve` `{url}` → track or playlist metadata, no download
  - `POST /api/start` `{url}` → begins conversion, returns a job id
  - `GET /api/status?job=` → progress percent / done / error
  - `GET /api/file?job=` → the finished MP3
- `index.html` — the whole frontend. Paste URL → per-track "get mp3"
  buttons with live progress bars → download link.
- `downloads/` — finished MP3s land here (git-ignored).

Format preference is `http_mp3_128/http_aac_160/bestaudio/best`: SoundCloud's
progressive streams first (fast, reliable), HLS avoided, and if the artist
enabled free downloads the original file wins via `/best`. Already-MP3
sources are kept as-is; anything else gets ffmpeg'd to MP3.

## Honest limits

- Stream rips top out at ~128k MP3 / 160k AAC — that's what SoundCloud serves.
  Only tracks with downloads enabled give you the artist's original file.
- Binds to `127.0.0.1` only. If you want it on your LAN, change the
  `ThreadingHTTPServer` bind address and know what you're doing.
