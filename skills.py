"""Skills: folders of instructions (a SKILL.md plus optional reference files and scripts) that
Qwen loads when a task calls for them, like Claude's skills. They live in qwen-chat/skills/.
Read-only: nothing here runs code; Code mode can run a skill's scripts with the user's approval."""
import os
import re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills")
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_FILE = 80_000  # characters of a supporting file handed to the model

SOURCES = {
    **dict.fromkeys(["pdf", "docx", "xlsx", "pptx", "skill-creator"], "Anthropic"),
    "frontend-design": "Anthropic",
    **dict.fromkeys(["tdd", "diagnosing-bugs", "prototype", "research", "domain-modeling", "codebase-design",
                     "code-review", "pr", "wizard", "grilling", "writing-for-agents"], "Matt Pocock"),
    "deep-research": "Qwen Chat",
}
# Software a skill's scripts expect; shown in the Skills list (Qwen never installs it itself)
NEEDS = {
    "pdf": "Python: pypdf, pdfplumber, reportlab · Homebrew: qpdf, poppler",
    "docx": "Python: defusedxml, lxml · LibreOffice, pandoc",
    "pptx": "Python: python-pptx, defusedxml, Pillow · LibreOffice",
    "xlsx": "Python: openpyxl, defusedxml · LibreOffice",
}
TOOL_NEEDS = {  # what the skill can only do with tools (Code mode)
    **dict.fromkeys(["pdf", "docx", "xlsx", "pptx", "skill-creator", "tdd", "diagnosing-bugs", "prototype",
                     "code-review", "pr", "codebase-design", "domain-modeling", "frontend-design"], "code"),
    **dict.fromkeys(["deep-research", "research"], "web"),
}


class SkillError(Exception):
    pass


def _frontmatter(text):
    meta, body = {}, text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            head, body = text[3:end], text[end + 4:].lstrip("\n")
            key = None
            for line in head.splitlines():
                m = re.match(r"^([A-Za-z_-]+):\s*(.*)$", line)
                if m:
                    key, val = m.group(1).lower(), m.group(2).strip()
                    meta[key] = "" if val in (">", "|", ">-", "|-") else val.strip("\"'")
                elif key and line.startswith((" ", "\t")):
                    meta[key] = (meta[key] + " " + line.strip()).strip()
    return meta, body


def _dir(name):
    if not NAME.match(name or ""):
        raise SkillError("unknown skill")
    d = os.path.join(ROOT, name)
    if not os.path.isfile(os.path.join(d, "SKILL.md")):
        raise SkillError(f"There's no skill called {name}")
    return d


def _files(d):
    out = []
    for base, dirs, files in os.walk(d):
        # agents/ holds settings for other AI tools (e.g. OpenAI), not instructions for Qwen
        dirs[:] = sorted(x for x in dirs if not x.startswith((".", "__")) and not (base == d and x == "agents"))
        for f in sorted(files):
            if f.startswith(".") or f == "SKILL.md" or f.upper().startswith("LICENSE"):
                continue
            out.append(os.path.relpath(os.path.join(base, f), d))
    return out


def list_skills():
    out = []
    if not os.path.isdir(ROOT):
        return out
    for name in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, name, "SKILL.md")
        if not NAME.match(name) or not os.path.isfile(p):
            continue
        with open(p, encoding="utf-8", errors="replace") as f:
            meta, _ = _frontmatter(f.read(4000))
        out.append({"name": name, "description": meta.get("description", "")[:600],
                    "source": SOURCES.get(name, "Yours"), "needs": NEEDS.get(name, ""),
                    "tools": TOOL_NEEDS.get(name, "")})
    return out


def get(name):
    d = _dir(name)
    with open(os.path.join(d, "SKILL.md"), encoding="utf-8", errors="replace") as f:
        meta, body = _frontmatter(f.read())
    return {"name": name, "description": meta.get("description", ""), "body": body.strip(),
            "dir": d, "files": _files(d), "source": SOURCES.get(name, "Yours"), "needs": NEEDS.get(name, "")}


def read_file(name, path):
    d = os.path.realpath(_dir(name))
    p = os.path.realpath(os.path.join(d, str(path or "")))
    if not p.startswith(d + os.sep) or not os.path.isfile(p):
        raise SkillError(f"{name} has no file {path!r}. Its files are: {', '.join(_files(d)) or 'none'}")
    with open(p, "rb") as f:
        raw = f.read(MAX_FILE * 4)
    if b"\x00" in raw[:4096]:
        raise SkillError(f"{path} is a binary file")
    text = raw.decode("utf-8", "replace")
    return text if len(text) <= MAX_FILE else text[:MAX_FILE] + f"\n… [cut at {MAX_FILE} characters]"
