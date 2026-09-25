#!/usr/bin/env python3
"""End-to-end tests for server.py against a fake yt-dlp. Stdlib only.

Run: python3 test_server.py   (no network, no real yt-dlp/ffmpeg needed)
"""

import http.client
import importlib.util
import json
import os
import stat
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# fake yt-dlp: logs argv, answers --dump-single-json, and for a download
# prints progress + writes an .mp3 whose name needs UTF-8 to survive
FAKE_YTDLP = r'''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_YTDLP_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
args = sys.argv[1:]
if "--dump-single-json" in args:
    print(json.dumps({"title": "Títle — 🔥", "uploader": "Uplöader",
                      "duration": 61, "webpage_url": args[-1]}))
    sys.exit(0)
out = args[args.index("-o") + 1]
path = out.replace("%(uploader)s", "Uplöader").replace("%(title)s", "Títle — 🔥").replace("%(ext)s", "mp3")
for p in (10, 55.5, 100):
    print(f"[download]  {p}% of 3.00MiB", flush=True)
with open(path, "wb") as f:
    f.write(b"ID3fake-mp3-bytes")
print(path, flush=True)
'''


def load_server():
    spec = importlib.util.spec_from_file_location("sc2mp3_server", os.path.join(HERE, "server.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        bindir = os.path.join(cls.tmp.name, "bin")
        os.makedirs(bindir)
        fake = os.path.join(bindir, "yt-dlp")
        with open(fake, "w") as f:
            f.write(FAKE_YTDLP)
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        cls.log = os.path.join(cls.tmp.name, "argv.log")
        os.environ["FAKE_YTDLP_LOG"] = cls.log
        os.environ["PATH"] = bindir + os.pathsep + os.environ["PATH"]

        cls.srv_mod = m = load_server()
        m.DL_DIR = os.path.join(cls.tmp.name, "downloads")
        os.makedirs(m.DL_DIR)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), m.Handler)
        cls.port = port = cls.httpd.server_address[1]
        m.ALLOWED_HOSTS = {f"127.0.0.1:{port}", f"localhost:{port}"}
        m.ALLOWED_ORIGINS = {f"http://127.0.0.1:{port}", "https://danfr4nk.github.io"}
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def setUp(self):
        open(self.log, "w").close()

    def req(self, method, path, body=None, origin=None, host=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Host": host or f"127.0.0.1:{self.port}"}
        if origin:
            headers["Origin"] = origin
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        c.request(method, path, body=data, headers=headers)
        r = c.getresponse()
        raw = r.read()
        c.close()
        return r, raw

    def calls(self):
        with open(self.log) as f:
            return [json.loads(line) for line in f if line.strip()]

    # --- request gating ---
    def test_foreign_origin_cannot_start_jobs(self):
        r, raw = self.req("POST", "/api/start", {"url": "https://soundcloud.com/a/b"},
                          origin="https://evil.example")
        self.assertEqual(r.status, 403)
        time.sleep(0.3)
        self.assertEqual(self.calls(), [])

    def test_rebound_host_rejected(self):
        r, _ = self.req("GET", "/api/ping", host="attacker.example:8765")
        self.assertEqual(r.status, 403)

    def test_cors_only_for_allowed_origins(self):
        r, _ = self.req("OPTIONS", "/api/start", origin="https://danfr4nk.github.io")
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), "https://danfr4nk.github.io")
        r, _ = self.req("OPTIONS", "/api/start", origin="https://evil.example")
        self.assertIsNone(r.getheader("Access-Control-Allow-Origin"))

    def test_non_soundcloud_and_option_injection_rejected(self):
        for url in ["https://evil.example/?soundcloud.com",
                    "--exec=touch /tmp/pwned #soundcloud.com",
                    "https://soundcloud.com.evil.example/x"]:
            r, raw = self.req("POST", "/api/start", {"url": url})
            self.assertIn("error", json.loads(raw), url)
        r, raw = self.req("POST", "/api/start", body=None)  # no body at all
        self.assertIn("error", json.loads(raw))
        time.sleep(0.3)
        self.assertEqual(self.calls(), [])

    def test_malformed_json_body_is_an_error_not_a_crash(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", "/api/resolve", body=b"{not json",
                  headers={"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"})
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        self.assertIn("error", json.loads(r.read()))
        c.close()

    # --- happy path ---
    def test_resolve_passes_url_after_double_dash(self):
        url = "https://soundcloud.com/artist/track"
        r, raw = self.req("POST", "/api/resolve", {"url": url}, origin="https://danfr4nk.github.io")
        self.assertEqual(r.status, 200)
        self.assertEqual(json.loads(raw)["title"], "Títle — 🔥")
        argv = self.calls()[0]
        self.assertEqual(argv[-2:], ["--", url])

    def test_full_job_downloads_unicode_titled_file(self):
        url = "https://soundcloud.com/artist/track"
        r, raw = self.req("POST", "/api/start", {"url": url}, origin=f"http://127.0.0.1:{self.port}")
        job = json.loads(raw)["job"]
        for _ in range(100):
            st = json.loads(self.req("GET", f"/api/status?job={job}")[1])
            if st["state"] in ("done", "error"):
                break
            time.sleep(0.05)
        self.assertEqual(st["state"], "done", st)
        self.assertNotIn("path", st)
        argv = self.calls()[0]
        self.assertEqual(argv[-2:], ["--", url])
        r, data = self.req("GET", f"/api/file?job={job}")
        self.assertEqual(r.status, 200)
        self.assertEqual(data, b"ID3fake-mp3-bytes")
        cd = r.getheader("Content-Disposition")
        self.assertIn("filename*=UTF-8''Upl%C3%B6ader%20-%20T%C3%ADtle%20%E2%80%94%20%F0%9F%94%A5.mp3", cd)
        self.assertTrue(cd.isascii())


if __name__ == "__main__":
    unittest.main(verbosity=2)
