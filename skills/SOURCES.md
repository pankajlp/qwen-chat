# Where these skills come from

Each skill folder is an unmodified copy of its source, with its licence file kept beside it.
Qwen Chat adds a short note at load time that maps Claude tool names to Qwen's tools and
explains which Claude-only features (subagents, AskUserQuestion, plugins) to do without.
That note lives in the app, not in these files.

| Skill | Source | Licence |
|---|---|---|
| pdf, docx, xlsx, pptx, skill-creator | Anthropic skills bundled with the Claude desktop app (copied 2026-11-07) | Apache 2.0 (LICENSE.txt in each folder) |
| frontend-design | claude-plugins-official marketplace, plugin `frontend-design` | Apache 2.0 (LICENSE.txt) |
| tdd, diagnosing-bugs, prototype, research, domain-modeling, codebase-design, code-review, pr, wizard, grilling, writing-for-agents | Matt Pocock, `mattpocock-skills` plugin v1.3.1 | MIT (LICENSE in each folder) |
| deep-research | Written for Qwen Chat (original text) | Same as Qwen Chat |

Not included: Anthropic's browser, Chrome and computer-use skills (proprietary licence, and they
only work inside Claude) and Anthropic skills that ship without a licence (deep-research, morning,
memory, docs, google-workspace, setup). Claude Code's built-in commands are part of Claude Code
itself, not skill files.

## Extra software some skills need
The document skills run Python libraries and tools that are not installed on this Mac yet:
- pdf: `pypdf`, `pdfplumber`, `reportlab` (Python); `qpdf`, `poppler` (Homebrew)
- docx, pptx, xlsx: `defusedxml`, `lxml`, `openpyxl`, `python-pptx`, `Pillow` (Python); LibreOffice, pandoc
Qwen will tell you what is missing rather than install anything itself.

To add your own skill: make a folder here with a `SKILL.md` that starts with
`---` / `name:` / `description:` / `---`, then reload Qwen Chat.
