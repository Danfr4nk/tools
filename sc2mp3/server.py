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
from urllib.parse import urlparse, parse_qs, quote

HERE = os.path.dirname(os.path.abspath(__file__))
DL_DIR = os.path.join(HERE, "downloads")
os.makedirs(DL_DIR, exist_ok=True)
PORT = 8765

# Prefer progressive HTTP streams (fast, single fetch). SoundCloud also offers
# HLS, but segment-by-segment fetching is slow/flaky on some networks.
# Trailing /best catches the artist's original file when downloads are enabled.
FORMAT = "http_mp3_128/http_aac_160/bestaudio/best"

# Browser origins allowed to drive the API: the page served by this server,
# and the copy deployed on the tools site. Any other website the user has
# open could otherwise POST here and make this machine run yt-dlp.
ALLOWED_ORIGINS = {
    f"http://127.0.0.1:{PORT}",
    f"http://localhost:{PORT}",
    "https://danfr4nk.github.io",
}
# Host header must name this server (defeats DNS rebinding)
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}

JOBS = {}
JOBS_LOCK = threading.Lock()
PROG_RE = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")


def soundcloud_url(url):
    """The URL if it's an http(s) link on soundcloud.com, else None.

    A substring test ("soundcloud.com" in url) let through both other hosts
    (https://evil.example/?soundcloud.com) and yt-dlp options
    ("--exec=... #soundcloud.com")."""
    try:
        u = urlparse(url)
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    if u.scheme not in ("http", "https"):
        return None
    if host != "soundcloud.com" and not host.endswith(".soundcloud.com"):
        return None
    return url


def content_disposition(filename):
    """attachment header that survives any title: http.server encodes headers
    as strict latin-1, so a title with an em dash or emoji used to crash the
    download. ASCII fallback + RFC 5987 UTF-8 filename*."""
    fallback = re.sub(r'[^\x20-\x7e]', "_", filename).replace('"', "").replace("\\", "")
    return (f'attachment; filename="{fallback}"; '
            f"filename*=UTF-8''{quote(filename, safe='')}")


def yt(args, timeout=90):
    return subprocess.run(
        ["yt-dlp"] + args, capture_output=True, text=True, timeout=timeout
    )


def resolve_url(url):
    """Return track/playlist metadata without downloading anything."""
    p = yt(["--dump-single-json", "--flat-playlist", "--no-warnings", "--", url])
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
        "-o", out, "--", url,
    ]
    try:
        final_path = None
        with subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        ) as p:
            for line in p.stdout:
                m = PROG_RE.search(line)
                if m:
                    set_job(job_id, pct=float(m.group(1)))
                if "[ExtractAudio]" in line or "Deleting original file" in line:
                    set_job(job_id, pct=100.0, note="converting to mp3…")
                s = line.strip()
                if s.lower().endswith(".mp3") and os.path.isabs(s):
                    final_path = s
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
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            # Chrome's private-network preflight (public site -> loopback)
            if self.headers.get("Access-Control-Request-Private-Network"):
                self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")

    def _guard(self, post=False):
        """False (and a 403 sent) if the request didn't come from this app.
        Host must be us; a POST — which spawns yt-dlp — must come from an
        allowed page, or from a non-browser client (no Origin at all)."""
        if self.headers.get("Host") not in ALLOWED_HOSTS:
            self._json({"error": "bad host"}, 403)
            return False
        origin = self.headers.get("Origin")
        if post and origin is not None and origin not in ALLOWED_ORIGINS:
            self._json({"error": "origin not allowed"}, 403)
            return False
        return True

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
        if not n:
            return {}
        try:
            body = json.loads(self.rfile.read(n).decode() or "{}")
        except (ValueError, UnicodeDecodeError):
            return {}
        return body if isinstance(body, dict) else {}

    def do_OPTIONS(self):  # noqa: N802
        if self.headers.get("Host") not in ALLOWED_HOSTS:
            return self._json({"error": "bad host"}, 403)
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if not self._guard():
            return
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
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header(
                "Content-Disposition", content_disposition(job["filename"]))
            self.end_headers()
            self.wfile.write(data)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802
        if not self._guard(post=True):
            return
        u = urlparse(self.path)
        if u.path == "/api/resolve":
            url = soundcloud_url(str(self._body().get("url") or "").strip())
            if not url:
                return self._json({"error": "that doesn't look like a SoundCloud URL"})
            try:
                self._json(resolve_url(url))
            except Exception as e:  # noqa: BLE001
                self._json({"error": f"couldn't read that URL: {e}"})
        elif u.path == "/api/start":
            url = soundcloud_url(str(self._body().get("url") or "").strip())
            if not url:
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
