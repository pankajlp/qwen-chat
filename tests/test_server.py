"""Security rules of server.py, checked against a real server on random ports.

Ollama is pointed at a dead address and voice at /usr/bin/false, so nothing outside is touched.
Run from the qwen-chat folder:  python3 -m unittest tests/test_server.py
"""
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER = "owner@example.com"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def req(port, path, method="GET", body=None, headers=None, host=None):
    h = dict(headers or {})
    h.setdefault("Host", host or f"localhost:{port}")
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.read().decode("utf-8", "replace")


class ServerRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port, cls.pub, cls.own = free_port(), free_port(), free_port()
        cls.project = tempfile.mkdtemp(prefix="qc-test-")
        with open(os.path.join(cls.project, "hello.txt"), "w") as f:
            f.write("hi\n")
        env = dict(os.environ, PORT=str(cls.port), PUBLIC_PORT=str(cls.pub), OWNER_PORT=str(cls.own),
                   OWNER_LOGIN=OWNER, OLLAMA_HOST="http://127.0.0.1:9", VOICE_PYTHON="/usr/bin/false")
        cls.proc = subprocess.Popen([sys.executable, "server.py", "--no-browser"], cwd=ROOT, env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                if req(cls.port, "/")[0] == 200 and req(cls.pub, "/")[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(0.1)
        page = req(cls.port, "/")[1]
        cls.token = re.search(r'name="code-token" content="([^"]+)"', page).group(1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)

    def tok(self, extra=None):
        return {"X-Code-Token": self.token, "Content-Type": "application/json", **(extra or {})}

    # ---- this Mac (local listener)
    def test_local_page_has_token(self):
        self.assertIn('name="code-token"', req(self.port, "/")[1])
        # not for a page reached under another host name (DNS rebinding)
        self.assertNotIn('name="code-token"', req(self.port, "/", host="evil.example")[1])

    def test_code_needs_token(self):
        body = {"root": self.project, "name": "read_file", "args": {"path": "hello.txt"}}
        self.assertEqual(req(self.port, "/code/tool", "POST", body, {"Content-Type": "application/json"})[0], 403)
        status, out = req(self.port, "/code/tool", "POST", body, self.tok())
        self.assertEqual(status, 200)
        self.assertIn("hi", json.loads(out)["result"])

    def test_code_refuses_foreign_host(self):  # DNS rebinding
        body = {"root": self.project, "name": "read_file", "args": {"path": "hello.txt"}}
        self.assertEqual(req(self.port, "/code/tool", "POST", body, self.tok(), host="evil.example:80")[0], 403)

    def test_code_stays_in_project(self):
        body = {"root": self.project, "name": "read_file", "args": {"path": "../../etc/passwd"}}
        self.assertIn("outside the project", json.loads(req(self.port, "/code/tool", "POST", body, self.tok())[1])["error"])

    def test_connectors_need_token(self):
        self.assertEqual(req(self.port, "/connectors/status", "POST", {}, {"Content-Type": "application/json"})[0], 403)

    def test_connector_callback_rules(self):
        self.assertIn("Couldn't connect", req(self.port, "/connectors/callback?state=forged&code=x")[1])
        self.assertEqual(req(self.port, "/connectors/callback?state=x", host="evil.example")[0], 404)

    def test_ocr_needs_token(self):
        self.assertEqual(req(self.port, "/ocr?name=a.png", "POST", b"\x89PNG....")[0], 403)

    def test_skills_read_only_and_contained(self):
        status, out = req(self.port, "/skills/list")
        self.assertEqual(status, 200)
        self.assertGreater(len(json.loads(out)["skills"]), 0)
        self.assertIn("error", json.loads(req(self.port, "/skills/file?name=pdf&path=../../server.py")[1]))

    # ---- public link
    def test_public_page_has_no_token_even_with_spoofed_host(self):
        self.assertNotIn('name="code-token"', req(self.pub, "/", host=f"localhost:{self.port}")[1])

    def test_public_refuses_owner_features(self):
        spoof = self.tok({"Tailscale-User-Login": OWNER})
        for path in ("/code/tool", "/connectors/status", "/connectors/tool"):
            self.assertEqual(req(self.pub, path, "POST", {}, spoof, host=f"localhost:{self.port}")[0], 403, path)
        self.assertEqual(req(self.pub, "/ocr?name=a.png", "POST", b"x", spoof, host=f"localhost:{self.port}")[0], 403)
        self.assertIn(req(self.pub, "/connectors/callback?state=x&code=y")[0], (403, 404))

    def test_public_ollama_allowlist(self):
        self.assertEqual(req(self.pub, "/api/pull", "POST", {"model": "x"}, {"Content-Type": "application/json"})[0], 403)
        self.assertEqual(req(self.pub, "/api/create", "POST", {"model": "x"}, {"Content-Type": "application/json"})[0], 403)
        self.assertNotEqual(req(self.pub, "/api/tags")[0], 403)  # allowed (Ollama is dead here, so 502)

    def test_public_serves_only_app_files(self):
        for path in ("/server.py", "/connectors.py", "/tests/test_server.py", "/vendor/../server.py", "/skills/pdf/SKILL.md"):
            self.assertIn(req(self.pub, path)[0], (404, 200 if path.startswith("/skills/") else 404), path)
        for path in ("/js/core.js", "/css/app.css", "/vendor/marked.min.js", "/voice-worker.js"):
            self.assertEqual(req(self.pub, path)[0], 200, path)

    def test_public_skills_hide_local_paths(self):
        self.assertNotIn('"dir"', req(self.pub, "/skills/get?name=tdd")[1])

    # ---- owner's devices (Tailscale identity)
    def test_owner_needs_identity(self):
        self.assertEqual(req(self.own, "/")[0], 403)
        self.assertEqual(req(self.own, "/", headers={"Tailscale-User-Login": "someone@else.com"})[0], 403)
        self.assertEqual(req(self.own, "/", headers={"Tailscale-User-Login": OWNER, "Tailscale-Funnel-Request": "?1"})[0], 403)
        status, page = req(self.own, "/", headers={"Tailscale-User-Login": OWNER})
        self.assertEqual(status, 200)
        self.assertIn('name="code-token"', page)

    def test_owner_can_use_code_mode(self):
        body = {"root": self.project, "name": "read_file", "args": {"path": "hello.txt"}}
        status, out = req(self.own, "/code/tool", "POST", body, self.tok({"Tailscale-User-Login": OWNER}), host="qwenfree.example:8443")
        self.assertEqual(status, 200)
        self.assertIn("hi", json.loads(out)["result"])

    def test_owner_cannot_start_sign_in(self):  # providers redirect to localhost, so connecting happens on the Mac
        out = json.loads(req(self.own, "/connectors/start", "POST", {"provider": "google"},
                             self.tok({"Tailscale-User-Login": OWNER}), host="qwenfree.example:8443")[1])
        self.assertIn("on your Mac", out.get("error", ""))


if __name__ == "__main__":
    unittest.main()
