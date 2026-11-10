"""Code mode tools: let the local model work inside one project folder.

Read-only tools (list_files, read_file, search) run straight away.
write_file, edit_file and run_command are previewed first (dry_run) and only
run after you click Allow in the app.

Every path is resolved inside the chosen project folder; anything that would
escape it (.., symlinks, absolute paths elsewhere) is refused.
"""
import difflib
import fnmatch
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import websearch  # noqa: E402

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".next", "dist", "build",
             ".mypy_cache", ".pytest_cache", ".idea", ".turbo", ".cache", "target"}
MAX_READ_BYTES = 2_000_000
MAX_OUTPUT = 12_000
PDFTEXT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin", "pdftext")
MAX_DOWNLOAD = 300_000_000


class ToolError(Exception):
    pass


def check_root(root):
    if not root or not os.path.isabs(root):
        raise ToolError("choose a project folder first")
    real = os.path.realpath(root)
    if not os.path.isdir(real):
        raise ToolError(f"folder not found: {root}")
    if real == "/" or real == os.path.realpath(os.path.expanduser("~")):
        raise ToolError("pick a specific project folder, not / or your whole home folder")
    return real


def resolve(root, path):
    path = (path or ".").strip()
    full = os.path.realpath(os.path.join(root, os.path.expanduser(path)))
    if full != root and not full.startswith(root + os.sep):
        raise ToolError(f"{path} is outside the project folder")
    return full


def rel(root, full):
    return os.path.relpath(full, root)


def clip(text, limit=MAX_OUTPUT):
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n… [{len(text) - limit} characters cut] …\n" + text[-half:]


def read_text(full):
    if os.path.getsize(full) > MAX_READ_BYTES:
        raise ToolError("file is too large to read (over 2 MB)")
    with open(full, "rb") as f:
        data = f.read()
    if b"\0" in data[:8000]:
        raise ToolError("this looks like a binary file")
    return data.decode("utf-8", errors="replace")


def diff(old, new, name):
    lines = difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True),
                                 f"a/{name}", f"b/{name}", n=3)
    return clip("".join(lines), 20_000) or "(no changes)"


# ---------- tools ----------

def list_files(root, path=".", depth=2):
    base = resolve(root, path)
    if not os.path.isdir(base):
        raise ToolError(f"not a folder: {path}")
    depth = max(1, min(int(depth or 2), 6))
    out, count = [], 0
    for dirpath, dirs, files in os.walk(base):
        level = rel(base, dirpath).count(os.sep) + (0 if dirpath == base else 1)
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
        if level >= depth:
            dirs[:] = []
        indent = "  " * level
        if dirpath != base:
            out.append(f"{indent[:-2]}{os.path.basename(dirpath)}/")
        for f in sorted(files):
            if f.startswith(".") and f not in (".env.example", ".gitignore"):
                continue
            out.append(f"{indent}{f}")
            count += 1
            if count >= 500:
                out.append("… (stopped after 500 files; list a subfolder for more)")
                return "\n".join(out)
    return "\n".join(out) or "(empty folder)"


def read_document(full, offset, limit):
    ext = os.path.splitext(full)[1].lower()
    if ext == ".pdf":
        if not os.path.exists(PDFTEXT):
            raise ToolError("PDF reader is missing (bin/pdftext)")
        first = max(1, int(offset or 1))
        last = first + max(1, min(int(limit or 10), 40)) - 1
        p = subprocess.run([PDFTEXT, full, str(first), str(last)], capture_output=True, text=True, timeout=120, errors="replace")
        if p.returncode:
            raise ToolError(p.stderr.strip() or "could not read the PDF")
        hint = ""
        if len(re.sub(r"\s|---\s*Page\s*\d+\s*---|Page \d+", "", p.stdout)) < 25 * (last - first + 1):
            hint = "\n(These pages have little or no text layer, so they are probably scans: use read_image_text on this file to read them from images.)"
        return clip(p.stdout + f"\n(read pages {first}-{last}; for more pages call read_file with offset=<first page> limit=<pages>)" + hint, 60_000)
    p = subprocess.run(["textutil", "-convert", "txt", "-stdout", full], capture_output=True, text=True, timeout=60, errors="replace")
    if p.returncode:
        raise ToolError(p.stderr.strip() or "could not read the document")
    return clip(p.stdout, 60_000)


def read_file(root, path, offset=1, limit=400):
    full = resolve(root, path)
    if not os.path.isfile(full):
        raise ToolError(f"file not found: {path}")
    if os.path.splitext(full)[1].lower() in (".pdf", ".docx", ".doc", ".rtf", ".odt"):
        return read_document(full, offset, limit if limit != 400 else None)
    lines = read_text(full).splitlines()
    offset = max(1, int(offset or 1))
    limit = max(1, min(int(limit or 400), 2000))
    chunk = lines[offset - 1: offset - 1 + limit]
    body = "\n".join(f"{i:>5}\t{line}" for i, line in enumerate(chunk, offset))
    more = len(lines) - (offset - 1 + len(chunk))
    if more > 0:
        body += f"\n… {more} more lines (read again with offset={offset + len(chunk)})"
    return clip(body or "(empty file)", 40_000)


def search(root, pattern, path=".", glob=None):
    base = resolve(root, path)
    try:
        rx = re.compile(pattern)
    except re.error as e:
        raise ToolError(f"bad regex: {e}")
    hits = []
    for dirpath, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for f in files:
            if glob and not fnmatch.fnmatch(f, glob):
                continue
            full = os.path.join(dirpath, f)
            try:
                if os.path.getsize(full) > MAX_READ_BYTES:
                    continue
                text = read_text(full)
            except (ToolError, OSError):
                continue
            for n, line in enumerate(text.splitlines(), 1):
                if rx.search(line):
                    hits.append(f"{rel(root, full)}:{n}: {line.strip()[:200]}")
                    if len(hits) >= 150:
                        return "\n".join(hits) + "\n… (stopped after 150 matches)"
    return "\n".join(hits) or "no matches"


def write_file(root, path, content, dry_run=True):
    full = resolve(root, path)
    if os.path.isdir(full):
        raise ToolError(f"{path} is a folder")
    exists = os.path.isfile(full)
    old = read_text(full) if exists else ""
    preview = diff(old, content, rel(root, full))
    if dry_run:
        return {"preview": preview, "summary": f"{'Overwrite' if exists else 'Create'} {rel(root, full)}"}
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(content)
    return f"{'Updated' if exists else 'Created'} {rel(root, full)} ({len(content.splitlines())} lines)"


def edit_file(root, path, old_string, new_string, replace_all=False, dry_run=True):
    full = resolve(root, path)
    if not os.path.isfile(full):
        raise ToolError(f"file not found: {path} (use write_file to create it)")
    if not old_string:
        raise ToolError("old_string is empty")
    old = read_text(full)
    n = old.count(old_string)
    if n == 0:
        raise ToolError("old_string was not found. Read the file again and copy the exact text, including spaces.")
    if n > 1 and not replace_all:
        raise ToolError(f"old_string appears {n} times. Add more surrounding lines so it is unique, or set replace_all.")
    new = old.replace(old_string, new_string) if replace_all else old.replace(old_string, new_string, 1)
    preview = diff(old, new, rel(root, full))
    if dry_run:
        return {"preview": preview, "summary": f"Edit {rel(root, full)}"}
    with open(full, "w", encoding="utf-8") as f:
        f.write(new)
    return f"Edited {rel(root, full)} ({n if replace_all else 1} replacement{'s' if replace_all and n > 1 else ''})"


def run_command(root, command, timeout=120, dry_run=True):
    command = (command or "").strip()
    if not command:
        raise ToolError("empty command")
    if dry_run:
        return {"preview": command, "summary": "Run a command"}
    timeout = max(1, min(int(timeout or 120), 600))
    try:
        p = subprocess.run(command, shell=True, cwd=root, capture_output=True, text=True,
                           timeout=timeout, stdin=subprocess.DEVNULL, errors="replace")
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or "") + (e.stderr or "") if isinstance(e.stdout, str) else ""
        return clip(f"Timed out after {timeout}s\n{out}")
    out = (p.stdout or "") + (("\n[stderr]\n" + p.stderr) if p.stderr.strip() else "")
    return clip(f"exit code {p.returncode}\n{out.strip()}")


def web_search(root, query, max_results=8):
    results = websearch.search(str(query)[:300], max_results=max(1, min(int(max_results or 8), 10)))
    if not results:
        return "no results"
    return "\n\n".join(f"{i}. {r.get('title', '')}\n   {r.get('url', '')}\n   {r.get('snippet', '')}" for i, r in enumerate(results, 1))


def web_fetch(root, url):
    try:
        page = websearch.fetch_text(str(url))
    except websearch.BlockedURL as e:
        raise ToolError(str(e))
    except Exception as e:
        raise ToolError(f"could not fetch {url}: {e}")
    more = "\n… (page text was cut; if you need a file from this page, use download_file)" if page.get("truncated") else ""
    return f"{page.get('title', '')}\n{page.get('url', url)}\n\n{page.get('text', '')}{more}"


def download_file(root, url, path, dry_run=True):
    full = resolve(root, path)
    if os.path.isdir(full):
        raise ToolError(f"{path} is a folder; give a file name")
    try:
        websearch.check_public_url(str(url))
    except websearch.BlockedURL as e:
        raise ToolError(str(e))
    if dry_run:
        return {"preview": f"{url}\n→ {rel(root, full)}", "summary": "Download a file"}
    os.makedirs(os.path.dirname(full), exist_ok=True)
    try:
        # Ask for the file as-is (no gzip transfer encoding) so it's saved exactly as published
        req = websearch.urllib.request.Request(str(url), headers={"User-Agent": websearch.USER_AGENT, "Accept-Encoding": "identity"})
        r = websearch._opener.open(req, timeout=60)
        if r.headers.get("Content-Encoding", "").lower() in ("gzip", "deflate", "br"):
            raise ToolError("the server sent a compressed transfer; try a different link to the file")
        size = 0
        with open(full + ".part", "wb") as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_DOWNLOAD:
                    raise ToolError("file is larger than 300 MB")
                f.write(chunk)
        os.replace(full + ".part", full)
    except ToolError:
        if os.path.exists(full + ".part"):
            os.remove(full + ".part")
        raise
    except Exception as e:
        if os.path.exists(full + ".part"):
            os.remove(full + ".part")
        raise ToolError(f"download failed: {e}")
    return f"Downloaded {rel(root, full)} ({size / 1e6:.1f} MB, {r.headers.get('Content-Type', 'unknown type')})"


def read_image_text(root, path, pages=""):
    """Read text from a scanned PDF or a photo in the project, using the local vision model (ocr.py)."""
    import ocr
    full = resolve(root, path)
    if not os.path.isfile(full):
        raise ToolError(f"{path} is not a file")
    try:
        return clip(ocr.read_all(full, pages), 80_000)
    except ocr.OCRError as e:
        raise ToolError(str(e))


TOOLS = {
    "list_files": list_files, "read_file": read_file, "search": search,
    "write_file": write_file, "edit_file": edit_file, "run_command": run_command,
    "web_search": web_search, "web_fetch": web_fetch, "download_file": download_file,
    "read_image_text": read_image_text,
}
NEEDS_APPROVAL = {"write_file", "edit_file", "run_command", "download_file"}


def call(root, name, args, dry_run=True):
    root = check_root(root)
    fn = TOOLS.get(name)
    if not fn:
        raise ToolError(f"unknown tool {name}")
    args = dict(args or {})
    if name in NEEDS_APPROVAL:
        args["dry_run"] = dry_run
    else:
        args.pop("dry_run", None)
    try:
        return fn(root, **args)
    except TypeError as e:
        raise ToolError(f"bad arguments for {name}: {e}")
    except OSError as e:
        raise ToolError(str(e))


PROJECTS_DIR = os.path.expanduser("~/QwenProjects")


def new_project(name):
    """Create an empty folder under ~/QwenProjects named after the request."""
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    slug = "-".join(slug.split("-")[:5])[:40].strip("-") or "project"
    os.makedirs(PROJECTS_DIR, exist_ok=True)
    path, n = os.path.join(PROJECTS_DIR, slug), 2
    while os.path.exists(path):
        path, n = os.path.join(PROJECTS_DIR, f"{slug}-{n}"), n + 1
    os.makedirs(path)
    return path


def reveal(root):
    root = check_root(root)
    subprocess.run(["open", root], timeout=10)
    return root


def pick_folder():
    """Open the macOS folder picker (runs on this Mac only)."""
    p = subprocess.run(["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose a project folder for Qwen")'],
                       capture_output=True, text=True, timeout=600)
    path = p.stdout.strip()
    return path.rstrip("/") if path else None
