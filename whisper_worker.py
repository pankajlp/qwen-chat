#!/usr/bin/env python3
"""Speech-to-text on the Mac's GPU (MLX Whisper), driven by server.py.

Run with a Python that has mlx_whisper and numpy (server.py uses VOICE_PYTHON).
Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
  request : {"id": ..., "lang": "hindi" | "en" | null, "audio": "<base64 mono 16 kHz PCM16 LE>"}
  reply   : {"id": ..., "text": "...", "seconds": 0.42}  or  {"id": ..., "error": "..."}
The first line written is {"ready": true, "model": ...} once the model is loaded.
"""
import base64
import json
import os
import sys
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")  # the model is already downloaded; never fetch at runtime

import numpy as np  # noqa: E402

MODEL = os.environ.get("VOICE_MODEL", "mlx-community/whisper-large-v3-turbo")
SR = 16000
# Whisper tends to invent these on silence or noise
FILLERS = {"", "you", "thank you", "thank you.", "thanks for watching!", "thanks for watching.", "bye.", "bye", ".", "so"}


def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def transcribe(whisper, audio, lang):
    if audio.size < SR // 4:  # under a quarter second: nothing to hear
        return ""
    result = whisper.transcribe(
        audio,
        path_or_hf_repo=MODEL,
        language=lang or None,  # None = detect automatically
        condition_on_previous_text=False,
        temperature=0.0,
        verbose=None,
    )
    # Drop segments Whisper itself rates as non-speech or degenerate
    parts = [
        s.get("text", "").strip()
        for s in result.get("segments", [])
        if s.get("no_speech_prob", 0) < 0.6 and s.get("avg_logprob", 0) > -1.2 and s.get("compression_ratio", 0) < 2.4
    ]
    text = " ".join(p for p in parts if p).strip()
    if text.lower() in FILLERS:
        return ""
    words = len(text.split())
    if words > 3 and words / (audio.size / SR) > 6:  # far faster than anyone speaks: made up
        return ""
    return text


def main():
    import mlx_whisper as whisper

    started = time.monotonic()
    transcribe(whisper, np.zeros(SR, dtype=np.float32), "en")  # load the model now, not on first use
    reply({"ready": True, "model": MODEL, "load_seconds": round(time.monotonic() - started, 1)})

    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id")
        try:
            pcm = base64.b64decode(req.get("audio") or "")
            audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            t0 = time.monotonic()
            text = transcribe(whisper, audio, req.get("lang"))
            reply({"id": rid, "text": text, "seconds": round(time.monotonic() - t0, 2)})
        except Exception as e:  # keep serving after a bad request
            reply({"id": rid, "error": str(e) or e.__class__.__name__})


if __name__ == "__main__":
    main()
