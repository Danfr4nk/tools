#!/usr/bin/env python3
"""sc2mp3 — paste a SoundCloud URL, get an MP3.

Backend for the sc2mp3 web app. Stdlib only (plus the yt-dlp binary and
ffmpeg on PATH). Serves the frontend itself, so the whole app is:

    pip install yt-dlp        # ffmpeg too: apt/brew install ffmpeg
    python3 server.py         # opens http://127.0.0.1:8765

Binds to loopback only. One user, one machine — no auth, no TLS, no regrets.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
DL_DIR = os.path.join(HERE, "downloads")
os.makedirs(DL_DIR, exist_ok=True)
PORT = 8765

# Prefer progressive HTTP streams (fast, single fetch). SoundCloud also offers
# HLS, but segment-by-segment fetching is slow/flaky on some networks.
# Trailing /best catches the artist's original file when downloads are enabled.
FORMAT = "http_mp3_128/http_aac_160/bestaudio/best"

JOBS = {}
JOBS_LOCK = threading.Lock()
PROG_RE = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")


def yt(args, timeout=90):
    return subprocess.run(
        ["yt-dlp"] + args, capture_output=True, text=True, timeout=timeout
    )


def resolve_url(url):
    """Return track/playlist metadata without downloading anything."""
    p = yt(["--dump-single-json", "--flat-playlist", "--no-warnings", url])
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "yt-dlp failed").strip()[-400:])
    info = json.loads(p.stdout)
    if info.get("_type") == "playlist" or info.get("entries"):
        tracks = []
        for e in info.get("entries") or []:
            if not e:
                continue
            tracks.append(
                {
                    "url": e.get("url") or e.get("webpage_url"),
                    "title": e.get("title") or "untitled",
                    "duration": e.get("duration"),
                }
            )
        return {
            "kind": "playlist",
            "title": info.get("title") or "playlist",
            "count": len(tracks),
            "tracks": tracks,
        }
    return {
        "kind": "track",
        "title": info.get("title") or "untitled",
        "uploader": info.get("uploader"),
        "duration": info.get("duration"),
        "url": info.get("webpage_url") or url,
    }


def set_job(job_id, **kw):
    with JOBS_LOCK:
        JOBS[job_id].update(kw)


def convert_worker(job_id, url):
    set_job(job_id, state="running", pct=0.0)
    out = os.path.join(DL_DIR, "%(uploader)s - %(title)s.%(ext)s")
    cmd = [
        "yt-dlp", "--newline", "--progress", "--no-warnings",
        "--print", "after_move:filepath",
        "-f", FORMAT,
        "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
        "-o", out, url,
    ]
    try:
        p = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        final_path = None
        for line in p.stdout:
            m = PROG_RE.search(line)
            if m:
                set_job(job_id, pct=float(m.group(1)))
            if "[ExtractAudio]" in line or "Deleting original file" in line:
                set_job(job_id, pct=100.0, note="converting to mp3…")
            s = line.strip()
            if s.lower().endswith(".mp3") and os.path.isabs(s):
                final_path = s
        p.wait()
        if p.returncode != 0 or not final_path or not os.path.exists(final_path):
            set_job(job_id, state="error",
                    error="download failed — bad URL or SoundCloud said no")
            return
        st = os.stat(final_path)
        set_job(job_id, state="done", pct=100.0,
                filename=os.path.basename(final_path),
                path=final_path, size=st.st_size)
    except Exception as e:  # noqa: BLE001
        set_job(job_id, state="error", error=str(e)[-300:])


class Handler(BaseHTTPRequestHandler):
    server_version = "sc2mp3/1.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        return json.loads(self.rfile.read(n).decode() or "{}") if n else {}

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                data = f.read()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif u.path == "/api/ping":
            self._json({"ok": True})
        elif u.path == "/api/status":
            job = JOBS.get(q.get("job", [""])[0])
            if not job:
                return self._json({"error": "unknown job"}, 404)
            public = {k: v for k, v in job.items() if k != "path"}
            self._json(public)
        elif u.path == "/api/file":
            job = JOBS.get(q.get("job", [""])[0])
            if not job or job.get("state") != "done":
                return self._json({"error": "not ready"}, 404)
            path = job["path"]
            if not os.path.exists(path):
                return self._json({"error": "file gone"}, 410)
            with open(path, "rb") as f:
                data = f.read()
            fn = job["filename"].replace('"', "")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header(
                "Content-Disposition", f'attachment; filename="{fn}"')
            self.end_headers()
            self.wfile.write(data)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802
        u = urlparse(self.path)
        if u.path == "/api/resolve":
            url = (self._body().get("url") or "").strip()
            if "soundcloud.com" not in url:
                return self._json({"error": "that doesn't look like a SoundCloud URL"})
            try:
                self._json(resolve_url(url))
            except Exception as e:  # noqa: BLE001
                self._json({"error": f"couldn't read that URL: {e}"})
        elif u.path == "/api/start":
            url = (self._body().get("url") or "").strip()
            if "soundcloud.com" not in url:
                return self._json({"error": "that doesn't look like a SoundCloud URL"})
            job_id = uuid.uuid4().hex[:12]
            with JOBS_LOCK:
                JOBS[job_id] = {"state": "queued", "pct": 0.0, "url": url}
            threading.Thread(target=convert_worker, args=(job_id, url),
                             daemon=True).start()
            self._json({"job": job_id})
        else:
            self._json({"error": "not found"}, 404)

    def log_message(self, *a):
        pass  # quiet


def main():
    if not shutil.which("yt-dlp"):
        print("!! yt-dlp not found on PATH — pip install yt-dlp", flush=True)
    if not shutil.which("ffmpeg"):
        print("!! ffmpeg not found on PATH — conversions may fail", flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"sc2mp3 running → http://127.0.0.1:{PORT}", flush=True)
    try:
        webbrowser.open(f"http://127.0.0.1:{PORT}")
    except Exception:  # noqa: BLE001
        pass
    srv.serve_forever()


if __name__ == "__main__":
    main()
