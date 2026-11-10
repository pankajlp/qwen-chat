#!/usr/bin/env python3
"""Tiny local server: serves the chat UI and proxies /api/* to Ollama (streaming)."""
import base64
import errno
import html
import secrets
import subprocess
import threading
import time
import http.server
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

import codetools
import connectors
import ocr
import skills
import websearch

OLLAMA = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
PORT = int(os.environ.get("PORT", "8765"))
connectors.PORT = PORT  # sign-in redirects come back to this Mac's own listener
# Optional second listener for a public link (e.g. Tailscale Funnel). It never offers Code mode,
# only proxies the Ollama calls the chat needs, and serves only the page's own files.
PUBLIC_PORT = int(os.environ.get("PUBLIC_PORT", "0"))
PUBLIC_API = {("POST", "/api/chat"), ("POST", "/api/show"), ("GET", "/api/tags"), ("GET", "/api/version")}
PUBLIC_FILES = ("/jev-calibration.js", "/voice-worker.js", "/voice-capture.js")
PUBLIC_MAX_CTX = 65536  # stops a visitor from asking for a context window that would exhaust memory
# Optional owner listener: the full app (Code mode included) for the owner's own devices.
# Put it behind `tailscale serve` (never funnel): Tailscale then vouches for who is asking
# with the Tailscale-User-Login header, and every request from anyone else is refused.
OWNER_PORT = int(os.environ.get("OWNER_PORT", "0"))
OWNER_LOGIN = os.environ.get("OWNER_LOGIN", "").strip().lower()
# Voice input on the Mac's GPU: a Python with mlx_whisper (Hey Buddy's venv already has it and the
# large-v3-turbo model). Without it, the page falls back to Whisper inside the browser.
_HEYBUDDY_PY = os.path.expanduser("~/.gemini/antigravity/scratch/hey-buddy/.venv/bin/python")
VOICE_PYTHON = os.environ.get("VOICE_PYTHON") or (_HEYBUDDY_PY if os.path.exists(_HEYBUDDY_PY) else "")
VOICE_MAX_BYTES = 16000 * 2 * 300  # 5 minutes of 16 kHz 16-bit audio


class VoiceEngine:
    """Keeps one whisper_worker.py process warm and feeds it one request at a time."""

    def __init__(self, python):
        self.python, self.proc, self.ready = python, None, False
        self.lock = threading.Lock()
        self.start_lock = threading.Lock()
        self.next_id = 0

    def available(self):
        return bool(self.python)

    def start(self):
        """Start (or restart) the worker in the background; returns immediately."""
        if not self.python:
            return
        with self.start_lock:
            if self.proc and self.proc.poll() is None:
                return
            self.ready = False
            self.proc = subprocess.Popen(
                [self.python, os.path.join(ROOT, "whisper_worker.py")],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, bufsize=1, cwd=ROOT,
            )
            threading.Thread(target=self._wait_ready, args=(self.proc,), daemon=True).start()

    def _wait_ready(self, proc):
        line = proc.stdout.readline()
        try:
            if json.loads(line).get("ready"):
                self.ready = True
                print("Voice: Whisper large-v3-turbo ready on the Mac's GPU", flush=True)
        except ValueError:
            print("Voice: Mac speech model failed to start", flush=True)

    def transcribe(self, pcm, lang):
        self.start()
        with self.lock:  # one at a time; the GPU is shared with Ollama
            for _ in range(600):  # wait for the model to load (a few seconds), at most a minute
                if self.ready or self.proc.poll() is not None:
                    break
                time.sleep(0.1)
            if not self.ready or self.proc.poll() is not None:
                raise RuntimeError("speech model on the Mac isn't running")
            self.next_id += 1
            self.proc.stdin.write(json.dumps({"id": self.next_id, "lang": lang, "audio": base64.b64encode(pcm).decode()}) + "\n")
            self.proc.stdin.flush()
            out = json.loads(self.proc.stdout.readline() or "{}")
        if "error" in out or "text" not in out:
            raise RuntimeError(out.get("error") or "no reply from the speech model")
        return out


VOICE = VoiceEngine(VOICE_PYTHON)
ROOT = os.path.dirname(os.path.abspath(__file__))
# Code mode can edit files and run commands, so its endpoints need this per-launch token.
# Only the page served from here gets it (injected into index.html); other websites can't read it.
CODE_TOKEN = secrets.token_urlsafe(24)


class Handler(http.server.SimpleHTTPRequestHandler):
    public = False  # True on the public listener (see PublicHandler)
    owner = False   # True on the owner listener (see OwnerHandler)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet

    def end_headers(self):
        # Cross-origin isolation lets on-device Whisper use multiple CPU threads (everything is same-origin)
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("X-Qwen-Chat", "1")  # lets a second launch recognise an already-running server
        if getattr(self, "_app_file", False):
            # The app's own scripts change when it's updated: make browsers re-check them
            # (vendor libraries and model files keep normal caching)
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _local_host(self):
        # Blocks DNS-rebinding: the request must be addressed to this machine by name.
        # The public listener never counts as local, whatever Host header a visitor sends.
        if self.public:
            return False
        if self.owner:
            return self._owner_ok()
        return self.headers.get("Host", "") in (f"localhost:{PORT}", f"127.0.0.1:{PORT}")

    def _owner_ok(self):
        # Set by tailscale serve for requests from the owner's tailnet devices; Funnel (internet)
        # traffic is marked with Tailscale-Funnel-Request and never counts.
        who = (self.headers.get("Tailscale-User-Login") or "").strip().lower()
        return bool(OWNER_LOGIN) and who == OWNER_LOGIN and not self.headers.get("Tailscale-Funnel-Request")

    def _index(self):
        with open(os.path.join(ROOT, "index.html"), "rb") as f:
            body = f.read()
        if not self.public:
            body = body.replace(b"</head>", f'<meta name="code-token" content="{CODE_TOKEN}" />\n</head>'.encode(), 1)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _code(self):
        if not self._local_host() or self.headers.get("X-Code-Token") != CODE_TOKEN:
            return self._json(403, {"error": "forbidden"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "bad request"})
        try:
            if self.path == "/code/pick":
                return self._json(200, {"root": codetools.pick_folder()})
            if self.path == "/code/new":
                return self._json(200, {"root": codetools.new_project(str(req.get("name", ""))[:200])})
            if self.path == "/code/reveal":
                return self._json(200, {"root": codetools.reveal(req.get("root"))})
            if self.path == "/code/check":
                return self._json(200, {"root": codetools.check_root(req.get("root"))})
            if self.path == "/code/tool":
                out = codetools.call(req.get("root"), req.get("name"), req.get("args"), req.get("dry_run", True))
                return self._json(200, out if isinstance(out, dict) else {"result": out})
            return self._json(404, {"error": "unknown code request"})
        except codetools.ToolError as e:
            return self._json(200, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": str(e) or e.__class__.__name__})

    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/index.html"):
            return self._index()
        if self.path.startswith("/api/"):
            return self._proxy()
        if self.path.startswith("/web/"):
            return self._web()
        if self.path.split("?")[0] == "/voice/status":
            VOICE.start()  # opening the page warms the model up, so the first recording is quick
            return self._json(200, {"mac": VOICE.available(), "ready": VOICE.ready})
        if self.path.split("?")[0] == connectors.CALLBACK_PATH:
            return self._connector_callback()
        if self.path.startswith("/skills/"):
            return self._skills()
        if self.public:
            path = urllib.parse.unquote(self.path.split("?")[0])
            if ".." in path or not (path in PUBLIC_FILES or path.startswith(("/vendor/", "/css/", "/js/"))):
                return self.send_error(404)
        self._app_file = not self.path.startswith("/vendor/")
        return super().do_GET()

    def _json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _web(self):
        # Only used when the app's Search toggle is on: /web/search?q=… and /web/fetch?url=…
        parts = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(parts.query)
        try:
            if parts.path == "/web/search" and q.get("q"):
                return self._json(200, {"results": websearch.search(q["q"][0][:300])})
            if parts.path == "/web/fetch" and q.get("url"):
                return self._json(200, websearch.fetch_text(q["url"][0]))
            return self._json(404, {"error": "unknown web request"})
        except websearch.BlockedURL as e:
            return self._json(403, {"error": str(e)})
        except urllib.error.HTTPError as e:
            return self._json(502, {"error": f"site returned HTTP {e.code}"})
        except Exception as e:
            return self._json(502, {"error": str(e) or e.__class__.__name__})

    def _connectors(self):
        # Owner only: this Mac (Host check + page token) or the owner's Tailscale devices. Never public.
        if self.public or not self._local_host() or self.headers.get("X-Code-Token") != CODE_TOKEN:
            return self._json(403, {"error": "forbidden"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}") if length <= 1_000_000 else {}
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "bad request"})
        pid = str(req.get("provider") or "")
        try:
            if self.path == "/connectors/status":
                return self._json(200, {"providers": connectors.status(), "tools": connectors.tool_schemas(),
                                        "write_tools": connectors.write_tools(), "can_connect": not self.owner})
            if self.path == "/connectors/client":
                connectors.save_client(pid, req.get("client_id"), req.get("client_secret", ""))
                return self._json(200, {"ok": True})
            if self.path == "/connectors/start":
                if self.owner:  # the provider redirects back to localhost, so sign-in has to happen on the Mac
                    return self._json(200, {"error": f"Connect accounts from Qwen Chat on your Mac (http://localhost:{PORT}). After that they work here too."})
                return self._json(200, {"url": connectors.start(pid)})
            if self.path == "/connectors/disconnect":
                connectors.disconnect(pid)
                return self._json(200, {"ok": True})
            if self.path == "/connectors/forget":
                connectors.forget(pid)
                return self._json(200, {"ok": True})
            if self.path == "/connectors/tool":
                return self._json(200, connectors.call(str(req.get("name") or ""), req.get("args"), req.get("dry_run", True) is not False))
            return self._json(404, {"error": "unknown connectors request"})
        except connectors.ConnectorError as e:
            return self._json(200, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": str(e) or e.__class__.__name__})

    def _skills(self):
        # Read-only skill instructions (qwen-chat/skills). Public visitors get them too, minus local paths.
        parts = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(parts.query)
        arg = lambda k: (q.get(k) or [""])[0]
        try:
            if parts.path == "/skills/list":
                return self._json(200, {"skills": skills.list_skills()})
            if parts.path == "/skills/get":
                g = skills.get(arg("name"))
                if self.public:
                    g.pop("dir", None)
                return self._json(200, g)
            if parts.path == "/skills/file":
                return self._json(200, {"text": skills.read_file(arg("name"), arg("path"))})
            return self._json(404, {"error": "unknown skills request"})
        except skills.SkillError as e:
            return self._json(200, {"error": str(e)})

    def _connector_callback(self):
        # Where Google / Microsoft / X send the browser back after sign-in. Only on this Mac's own
        # listener; the one-time `state` from /connectors/start ties it to a sign-in the owner began.
        if self.public or self.owner or self.headers.get("Host", "") not in (f"localhost:{PORT}", f"127.0.0.1:{PORT}"):
            return self.send_error(404)
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        arg = lambda k: (q.get(k) or [""])[0]
        try:
            name, account = connectors.finish(arg("state"), arg("code"), arg("error_description") or arg("error"))
            title, text, ok = f"{name} connected", f"Qwen can now use {html.escape(account or 'your ' + name + ' account')}.", True
        except connectors.ConnectorError as e:
            title, text, ok = "Couldn't connect", html.escape(str(e)), False
        body = f"""<!doctype html><meta charset="utf-8"><title>{title}</title>
<style>body{{font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;background:#faf9f5;color:#1f1e1d}}
div{{max-width:420px;text-align:center}}h1{{font:500 24px Georgia,serif}}p{{color:#6b6a64}}</style>
<div><h1>{'✓ ' if ok else ''}{title}</h1><p>{text}</p><p>You can close this tab and go back to Qwen Chat.</p></div>""".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _ocr(self):
        # Read text from a scanned PDF or photo (body = the file). Owner only: it parses untrusted
        # files and uses the GPU heavily. Streams one JSON line per page so the page can show progress.
        if self.public or not self._local_host() or self.headers.get("X-Code-Token") != CODE_TOKEN:
            return self._json(403, {"error": "forbidden"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= ocr.MAX_BYTES:
            return self._json(413, {"error": "File must be under 60 MB"})
        data = self.rfile.read(length)
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        arg = lambda k: (q.get(k) or [""])[0]
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            for ev in ocr.read_bytes(data, arg("name"), arg("pages"), arg("lang") or None):
                self.wfile.write((json.dumps(ev, ensure_ascii=False) + "\n").encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self.wfile.write((json.dumps({"error": str(e) or e.__class__.__name__}) + "\n").encode())
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_POST(self):
        if self.path.split("?")[0] == "/ocr":
            return self._ocr()
        if self.path.startswith("/connectors/"):
            return self._connectors()
        if self.path.startswith("/code/"):
            return self._code()
        if self.path.startswith("/api/"):
            return self._proxy()
        if self.path.split("?")[0] == "/voice/transcribe":
            return self._transcribe()
        self.send_error(404)

    def _transcribe(self):
        # Body: mono 16 kHz signed 16-bit little-endian PCM. ?lang=<Whisper language name or code>
        if not VOICE.available():
            return self._json(503, {"error": "no speech model on the Mac"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= VOICE_MAX_BYTES or length % 2:
            return self._json(413 if length > VOICE_MAX_BYTES else 400, {"error": "audio must be 16-bit PCM, at most 5 minutes"})
        pcm = self.rfile.read(length)
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        lang = (q.get("lang") or [""])[0][:20].strip().lower() or None
        if lang and not lang.replace(" ", "").isalpha():
            return self._json(400, {"error": "bad language"})
        try:
            return self._json(200, VOICE.transcribe(pcm, lang))
        except Exception as e:
            return self._json(503, {"error": str(e) or e.__class__.__name__})

    def _proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        if self.public:
            # Visitors may chat and list models, but not pull, delete, create or copy them
            if (self.command, self.path.split("?")[0]) not in PUBLIC_API:
                return self._json(403, {"error": "not available on the public link"})
            if body:
                try:
                    j = json.loads(body)
                    opts = j.get("options") if isinstance(j.get("options"), dict) else {}
                    if int(opts.get("num_ctx") or 0) > PUBLIC_MAX_CTX:
                        opts["num_ctx"] = PUBLIC_MAX_CTX
                        j["options"] = opts
                    j.pop("keep_alive", None)
                    body = json.dumps(j).encode()
                except (ValueError, TypeError, AttributeError):
                    return self._json(400, {"error": "bad request"})
        req = urllib.request.Request(
            OLLAMA + self.path,
            data=body,
            method=self.command,
            headers={"Content-Type": "application/json"},
        )
        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            resp = e
        except Exception as e:
            msg = f'{{"error": "Cannot reach Ollama at {OLLAMA}: {e}"}}'.encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return

        self.send_response(resp.status if hasattr(resp, "status") else resp.code)
        self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            while True:
                chunk = resp.read1(8192) if hasattr(resp, "read1") else resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # user pressed Stop
        finally:
            resp.close()


class PublicHandler(Handler):
    public = True


class OwnerHandler(Handler):
    owner = True

    def _refuse(self):
        self._json(403, {"error": "This link is only for the owner's own Tailscale devices."})

    def do_GET(self):
        return super().do_GET() if self._owner_ok() else self._refuse()

    def do_POST(self):
        return super().do_POST() if self._owner_ok() else self._refuse()

    def do_HEAD(self):
        return super().do_HEAD() if self._owner_ok() else self._refuse()


def already_running(url):
    """True if Qwen Chat is already being served at this URL."""
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return r.headers.get("X-Qwen-Chat") == "1"
    except Exception:
        return False


if __name__ == "__main__":
    url = f"http://localhost:{PORT}"
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        if already_running(url):
            print(f"Qwen Chat is already running at {url} — opening it.")
            if "--no-browser" not in sys.argv:
                webbrowser.open(url)
            sys.exit(0)
        print(f"Port {PORT} is being used by another program.\n"
              f"Start on a different port instead, e.g.:  PORT=8766 python3 {sys.argv[0]}")
        sys.exit(1)
    if PUBLIC_PORT:
        public = http.server.ThreadingHTTPServer(("127.0.0.1", PUBLIC_PORT), PublicHandler)
        threading.Thread(target=public.serve_forever, daemon=True).start()
        print(f"Public listener (no Code mode) on http://127.0.0.1:{PUBLIC_PORT}")
    if OWNER_PORT and OWNER_LOGIN:
        owner = http.server.ThreadingHTTPServer(("127.0.0.1", OWNER_PORT), OwnerHandler)
        threading.Thread(target=owner.serve_forever, daemon=True).start()
        print(f"Owner listener (Code mode, {OWNER_LOGIN} only) on http://127.0.0.1:{OWNER_PORT}")
    print(f"Qwen Chat running at {url}  (Ollama: {OLLAMA})  — Ctrl+C to stop")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBye")
