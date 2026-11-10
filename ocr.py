"""Read text from scanned PDFs and photos.

Pages are rendered with poppler (pdftoppm) and read by a local vision model through Ollama
(qwen3.8 by default). In a test it transcribed Hindi exactly where Tesseract garbled joined letters.
Tesseract is the fallback when no vision model is available. Everything runs on this Mac.
"""
import base64
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request

OLLAMA = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
VISION_MODEL = os.environ.get("VISION_MODEL", "qwen3.8:27b")
PDFTOPPM = shutil.which("pdftoppm") or "/opt/homebrew/bin/pdftoppm"
PDFINFO = shutil.which("pdfinfo") or "/opt/homebrew/bin/pdfinfo"
TESSERACT = shutil.which("tesseract") or "/opt/homebrew/bin/tesseract"
MAX_PAGES = 30
MAX_BYTES = 60 * 1024 * 1024
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic")

PROMPT = ("Transcribe all the text in this image exactly as it appears. Keep the original language and script: "
          "do not translate, summarise or correct anything. Preserve line breaks. Write tables as rows with "
          "columns separated by ' | '. If the image contains no text, reply exactly: [no text]")


class OCRError(Exception):
    pass


_caps = {}


def _vision_model():
    """The configured vision model if Ollama has it, else None."""
    if VISION_MODEL in _caps:
        return _caps[VISION_MODEL]
    ok = None
    try:
        req = urllib.request.Request(OLLAMA + "/api/show", json.dumps({"model": VISION_MODEL}).encode())
        with urllib.request.urlopen(req, timeout=10) as r:
            if "vision" in (json.load(r).get("capabilities") or []):
                ok = VISION_MODEL
    except Exception:
        ok = None
    _caps[VISION_MODEL] = ok
    return ok


def engine():
    return _vision_model() or ("tesseract" if os.path.exists(TESSERACT) else None)


def _read_with_model(model, png):
    body = {"model": model, "stream": False, "think": False,
            "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 4000},
            "messages": [{"role": "user", "content": PROMPT, "images": [base64.b64encode(png).decode()]}]}
    req = urllib.request.Request(OLLAMA + "/api/chat", json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=600) as r:
        text = (json.load(r).get("message") or {}).get("content", "").strip()
    return "" if text == "[no text]" else text


def _read_with_tesseract(path, lang):
    r = subprocess.run([TESSERACT, path, "stdout", "-l", lang or "eng+hin"], capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise OCRError("Tesseract failed: " + (r.stderr.strip()[-300:] or f"code {r.returncode}"))
    return r.stdout.strip()


def page_count(pdf_path):
    r = subprocess.run([PDFINFO, pdf_path], capture_output=True, text=True, timeout=60)
    for line in r.stdout.splitlines():
        if line.startswith("Pages:"):
            return int(line.split()[1])
    raise OCRError("Couldn't open this PDF (it may be damaged or password-protected)")


def _render(pdf_path, page, outdir):
    base = os.path.join(outdir, f"p{page}")
    r = subprocess.run([PDFTOPPM, "-f", str(page), "-l", str(page), "-r", "200", "-scale-to", "1800",
                        "-png", "-singlefile", pdf_path, base], capture_output=True, text=True, timeout=120)
    if r.returncode != 0 or not os.path.exists(base + ".png"):
        raise OCRError(f"Couldn't render page {page}: {r.stderr.strip()[-200:]}")
    return base + ".png"


def _to_png(path, outdir):
    """Images the vision model may not take directly (HEIC, TIFF…) are converted with macOS sips."""
    if path.lower().endswith((".png", ".jpg", ".jpeg")):
        return path
    out = os.path.join(outdir, "image.png")
    r = subprocess.run(["sips", "-s", "format", "png", path, "--out", out], capture_output=True, text=True, timeout=120)
    if r.returncode != 0 or not os.path.exists(out):
        raise OCRError("Couldn't read this image format")
    return out


def parse_pages(spec, total):
    """'' → all pages (capped), '2', '1-3', '1,4,6-7' → sorted unique page numbers."""
    if not str(spec or "").strip():
        return list(range(1, min(total, MAX_PAGES) + 1))
    pages = set()
    for part in str(spec).replace(" ", "").split(","):
        if not part:
            continue
        a, _, b = part.partition("-")
        try:
            lo, hi = int(a), int(b or a)
        except ValueError:
            raise OCRError(f"Pages should look like 1-3 or 2,5 (got {spec!r})")
        pages.update(range(max(1, lo), min(total, hi) + 1))
    if not pages:
        raise OCRError(f"This PDF has {total} page(s)")
    return sorted(pages)[:MAX_PAGES]


def read_path(path, pages="", lang=None):
    """Yield {"total"}, then {"page", "text"} per page, then {"done", "engine"}."""
    eng = engine()
    if not eng:
        raise OCRError("No OCR engine: install a vision model in Ollama (e.g. qwen3.8) or Tesseract")
    ext = os.path.splitext(path)[1].lower()
    with tempfile.TemporaryDirectory() as tmp:
        if ext == ".pdf":
            todo = parse_pages(pages, page_count(path))
            yield {"total": len(todo)}
            for p in todo:
                png = _render(path, p, tmp)
                text = _read_with_tesseract(png, lang) if eng == "tesseract" else _read_with_model(eng, open(png, "rb").read())
                yield {"page": p, "text": text}
        elif ext in IMAGE_EXT:
            yield {"total": 1}
            png = _to_png(path, tmp)
            text = _read_with_tesseract(png, lang) if eng == "tesseract" else _read_with_model(eng, open(png, "rb").read())
            yield {"page": 1, "text": text}
        else:
            raise OCRError("I can read text from PDFs and images (PNG, JPG, HEIC, TIFF…)")
    yield {"done": True, "engine": eng}


def read_bytes(data, name, pages="", lang=None):
    """Same as read_path, for an uploaded file."""
    if len(data) > MAX_BYTES:
        raise OCRError("File is larger than 60 MB")
    ext = os.path.splitext(name or "")[1].lower()
    if ext not in IMAGE_EXT + (".pdf",):
        ext = ".pdf" if data[:5] == b"%PDF-" else ".png"
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "upload" + ext)
        with open(p, "wb") as f:
            f.write(data)
        yield from read_path(p, pages, lang)


def read_all(path, pages="", lang=None):
    """Whole result as text, for Code mode's read_image_text tool."""
    parts, eng, total = [], "", 0
    for ev in read_path(path, pages, lang):
        if "total" in ev:
            total = ev["total"]
        elif "page" in ev:
            parts.append((f"--- Page {ev['page']} ---\n" if total > 1 or path.lower().endswith(".pdf") else "") + (ev["text"] or "[no text found]"))
        elif ev.get("done"):
            eng = ev["engine"]
    return "\n\n".join(parts) + f"\n\n[transcribed from images by {'Tesseract' if eng == 'tesseract' else eng}]"
