# Qwen Chat — how it's put together

## The page
`index.html` is only the layout (about 290 lines). Styles are in `css/app.css`. The behaviour is split
by feature into `js/`, loaded in this order (they share one global scope, so order matters: code that
runs at startup can only use things from the same or earlier files):

| File | What it does |
|---|---|
| `js/core.js` | Icons, storage, markdown, sidebar, messages, edit/regenerate versions |
| `js/attachments.js` | Attaching files; scanned PDFs and photos via OCR |
| `js/voice.js` | Voice input (transcribed on the Mac's GPU, browser Whisper as fallback) |
| `js/memory.js` | Facts Qwen remembers about you (in this browser) |
| `js/talk.js` | Hands-free voice conversation |
| `js/export-import.js` | Exporting and importing chats |
| `js/web-search.js` | Web search before answering |
| `js/answer-checks.js` | Auto routing, Verify (fact-checking), consistency, confidence highlights |
| `js/jev.js` | Jev mode and calibration |
| `js/chat.js` | Sending and generating replies; composer, theme, settings, startup |
| `js/code-mode.js` | Code mode (project folder, tools, approvals) |
| `js/connectors.js` | Google / Microsoft / X accounts (owner only) |
| `js/skills.js` | `/name` skills |
| `js/start.js` | Runs last; starts the self-test when the URL has `?selftest` |
| `js/selftest.js` | The page self-test (only loaded with `?selftest`) |

## The server
| File | What it does |
|---|---|
| `server.py` | Serves the page; three listeners: this Mac (full), public link (chat only), owner's devices (Code mode, checked by Tailscale identity) |
| `codetools.py` | Code mode tools, locked to the project folder |
| `connectors.py` | OAuth sign-in and the Google / Microsoft / X tools; tokens in the macOS Keychain |
| `skills.py` | Reads `skills/` (read-only) |
| `ocr.py` | Reads scans and photos with the local vision model (Tesseract fallback) |
| `websearch.py` | DuckDuckGo search and page fetching |
| `whisper_worker.py` | Speech-to-text on the GPU (run by server.py) |

## Checking changes
- `./test.sh` runs the server tests: every security rule (tokens, public link, owner identity, file
  access) and the connectors, against a throwaway server. A few seconds; touches nothing real.
- Open the app with `?selftest` to run the page self-test: chat, skills, attachments, scans, Verify,
  Code mode approvals, account approvals, connectors form, voice. It fakes the model and server and
  puts your chats and settings back afterwards.
