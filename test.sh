#!/bin/sh
# Run all of Qwen Chat's automatic checks.
#   ./test.sh            server tests (security rules, connectors) — a few seconds, touches nothing real
# The page self-test runs in the browser: open the app with ?selftest, e.g. http://localhost:8766/?selftest
cd "$(dirname "$0")" || exit 1
echo "== Server tests"
python3 -W error::ResourceWarning -m unittest tests/test_server.py tests/test_connectors.py || exit 1
echo
echo "== Python files compile"
python3 -m py_compile server.py codetools.py connectors.py skills.py ocr.py websearch.py whisper_worker.py && echo "OK"
echo
echo "Page self-test: open the app with ?selftest (for example http://localhost:8766/?selftest)."
echo "It fakes the model and server, clicks through the main features, and restores your chats afterwards."
