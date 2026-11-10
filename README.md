# Qwen Chat

A Claude-style chat app for local models served by [Ollama](https://ollama.com). It is one Python
server with no dependencies beyond the standard library, plus a plain HTML/JS page. Everything runs
on your own machine.

## What it does
- **Chat** with any Ollama model. It includes thinking mode, markdown and code highlighting,
  edit/regenerate with versions, and export/import.
- **Thinking rescue:** when a thinking model runs out of its token budget before answering, the
  app asks it once more, with thinking off, to answer from the end of its own reasoning. On the
  AIME benchmark this raised a 16k-token budget from 55.0% to 73.3%. The study is in
  [answer-checker-bias](https://github.com/pankajlp/answer-checker-bias).
- **Attachments:** PDFs, Word files, images, and scanned pages through OCR with a local vision
  model, with Tesseract as a fallback.
- **Web search** before answering (DuckDuckGo), plus **Verify**, which fact-checks the answer, and
  confidence highlights.
- **Voice input** and a hands-free **talk** mode. Speech is transcribed on the GPU with
  `mlx_whisper`, or in the browser with Whisper/ONNX as a fallback.
- **Memory:** facts the model remembers about you, stored in your browser.
- **Code mode:** the model can read and edit files in one project folder. Every change needs your
  approval.
- **Connectors:** Google, Microsoft and X accounts through your own OAuth app. Tokens are kept in
  the macOS Keychain and are owner-only.
- **Skills:** type `/name` to load a skill from `skills/`. See [skills/SOURCES.md](skills/SOURCES.md)
  for where each one comes from and its licence.

See [STRUCTURE.md](STRUCTURE.md) for how the code is laid out.

## Run it
```sh
ollama pull qwen3:14b          # or any model; pick it from the menu in the app
PORT=8766 python3 server.py    # then open http://localhost:8766
```
`start.command` does the same and can be double-clicked on macOS.

### Optional
| Variable | Use |
|---|---|
| `OLLAMA_HOST` | Ollama address (default `http://localhost:11434`) |
| `PUBLIC_PORT` | Also serve a **chat-only** listener (no Code mode, files or accounts), for example behind Tailscale Funnel |
| `OWNER_PORT`, `OWNER_LOGIN` | Full app for your own devices behind `tailscale serve`. Tailscale's identity header must match `OWNER_LOGIN`. Never put this behind Funnel. |
| `VOICE_PYTHON` | A Python with `mlx_whisper` and `numpy`, for GPU speech-to-text |

The weights for the in-browser Whisper fallback (about 1.2 GB) are not in the repo. To get them:
```sh
./fetch-models.sh            # or: ./fetch-models.sh base
```

## Tests
```sh
./test.sh                    # server tests: security rules, connectors (a few seconds, touches nothing real)
```
For the page self-test, open `http://localhost:8766/?selftest`. It fakes the model and server,
clicks through the main features, and puts your chats back afterwards.

## Licence
MIT for the app ([LICENSE](LICENSE)). Bundled third-party files keep their own licences:
- the libraries in `vendor/` (marked, highlight.js, DOMPurify, pdf.js, mammoth, transformers.js,
  and fonts under the SIL OFL);
- the skills in `skills/` (Apache 2.0 or MIT, with the licence file kept in each folder).
