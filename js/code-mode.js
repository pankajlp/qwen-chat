// Code mode: Qwen works in a project folder with tools (server: codetools.py).
// Loaded in order by index.html; all files share one global scope (classic scripts).
// ===================== Code mode =====================
// Qwen works inside one project folder with Claude Code–style tools. Reading is automatic;
// edits and commands are previewed and wait for your Allow. The server (codetools.py) keeps
// every path inside the folder.
const CODE_TOKEN = document.querySelector('meta[name="code-token"]')?.content || '';
// No token means this page came from the public link: Code mode isn't available there
if (!CODE_TOKEN) { document.documentElement.classList.add('no-code'); }
let codeDraft = null;  // folder picked for the next new chat
const CODE_APPROVAL = { write_file: 'edits', edit_file: 'edits', run_command: 'commands', download_file: 'downloads' };
const CODE_MAX_STEPS = 150;
// Commands that can change things outside the project (or can't be undone) always ask,
// even after "Always allow commands"
const RISKY_CMD = /(^|[\s;&|()`])(sudo|su|rm|rmdir|mv|dd|mkfs|diskutil|brew|port|pip|pip3|pipx|uv\s+(pip|tool)|conda|gem|cargo\s+install|go\s+install|npm\s+(i|install|uninstall|publish|update|link)|npx|yarn\s+(add|global|remove)|pnpm\s+(add|install|remove)|apt|curl|wget|ssh|scp|rsync|git\s+(push|reset|clean|checkout|rebase|commit|merge|branch\s+-[dD])|chmod|chown|kill|killall|pkill|launchctl|defaults|osascript|open|shutdown|reboot|crontab|security)(?=$|[\s;&|()`])|\|\s*(sh|bash|zsh|python3?)\b|>\s*[~\/]/;
const riskyCommand = (cmd) => RISKY_CMD.test(String(cmd || ''));
const CODE_TOOLS = [
  { name: 'list_files', description: 'List files and folders (skips .git, node_modules, build folders). Start here to see the project layout.',
    params: { path: ['string', 'Folder relative to the project, default "."'], depth: ['integer', 'How many levels deep, 1-6, default 2'] }, required: [] },
  { name: 'read_file', description: 'Read a file. Text files come back with numbered lines ("   12\\tcode"; the number and tab are not part of the file). PDFs come back as text, 10 pages at a time (offset = first page, limit = number of pages). Word/RTF documents come back as plain text.',
    params: { path: ['string', 'File path relative to the project'], offset: ['integer', 'First line (or first PDF page), default 1'], limit: ['integer', 'Max lines (or PDF pages)'] }, required: ['path'] },
  { name: 'read_image_text', description: 'Read the text in a scanned PDF or a photo/screenshot (PNG, JPG, HEIC, TIFF) in the project, using the local vision model. Works for Hindi and other scripts. Use it when read_file finds little or no text in a PDF. About 5-10 seconds per page.',
    params: { path: ['string', 'File path relative to the project'], pages: ['string', 'PDF pages, e.g. "1-3" or "2,5"; default all (max 30)'] }, required: ['path'] },
  { name: 'search', description: 'Search file contents with a regular expression. Returns file:line: text for each match.',
    params: { pattern: ['string', 'Regular expression (Python syntax)'], path: ['string', 'Folder to search, default "."'], glob: ['string', 'Only files whose name matches, e.g. "*.py"'] }, required: ['pattern'] },
  { name: 'edit_file', description: 'Replace exact text in an existing file. old_string must match the file exactly (copy it from read_file without the line numbers) and be unique; include a few surrounding lines if needed.',
    params: { path: ['string', 'File path'], old_string: ['string', 'Exact text to replace'], new_string: ['string', 'Replacement text'], replace_all: ['boolean', 'Replace every occurrence'] }, required: ['path', 'old_string', 'new_string'] },
  { name: 'write_file', description: 'Create a new file, or completely replace a file. Prefer edit_file for changes to existing files.',
    params: { path: ['string', 'File path'], content: ['string', 'The full file content'] }, required: ['path', 'content'] },
  { name: 'web_search', description: 'Search the web (DuckDuckGo). Use it to find papers, datasets (OSF, GitHub, journal supplements), documentation and error messages.',
    params: { query: ['string', 'Search terms'], max_results: ['integer', 'Up to 10, default 8'] }, required: ['query'] },
  { name: 'web_fetch', description: 'Read the text of a web page (HTML). For data files or PDFs, use download_file instead.',
    params: { url: ['string', 'Full http(s) URL'] }, required: ['url'] },
  { name: 'download_file', description: 'Download a file from the web into the project folder (data, PDFs, code archives). The user approves each download.',
    params: { url: ['string', 'Direct http(s) URL of the file'], path: ['string', 'Where to save it, relative to the project, e.g. data/raw.csv'] }, required: ['url', 'path'] },
  { name: 'update_plan', description: 'Write or update your step-by-step plan. Call it at the start of any multi-step task, and again whenever a step is finished or the plan changes. The current plan is shown to the user and kept in your instructions.',
    params: { steps: ['array', 'All steps in order, each {"step": "short description", "status": "pending" | "in_progress" | "done"}'] }, required: ['steps'] },
  { name: 'run_command', description: 'Run a shell command (zsh on macOS) in the project folder, e.g. to run tests, a script, git status or install packages. Returns exit code and output.',
    params: { command: ['string', 'The command'], timeout: ['integer', 'Seconds before it is stopped, default 120'] }, required: ['command'] },
].map(({ name, description, params, required }) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', required,
    properties: Object.fromEntries(Object.entries(params).map(([k, [type, d]]) => [k, type === 'array'
      ? { type, description: d, items: { type: 'object', properties: { step: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['step', 'status'] } }
      : { type, description: d }])) } },
}));

async function codePost(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Code-Token': CODE_TOKEN }, body: JSON.stringify(body || {}) });
  const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (res.status === 403) throw new Error('Code mode is locked — reload the page (the server was restarted).');
  return j;
}

const codeRootNow = () => (current ? current.code?.root : codeDraft) || null;
const NEW_PROJECT = ':new';  // folder is created from the first message
const baseName = (p) => p === NEW_PROJECT ? 'New project' : p.split('/').filter(Boolean).pop() || p;

function updateCodeUI() {
  const root = codeRootNow();
  document.body.classList.toggle('code-mode', !!root);
  $('#code-btn').setAttribute('aria-pressed', String(!!root));
  $('#code-label').textContent = root ? baseName(root) : 'Code';
  $('#code-menu [data-code="reveal"]').hidden = !root || root === NEW_PROJECT;
  $('#code-menu [data-code="off"]').hidden = !root;
  $('#code-btn').title = root ? (root === NEW_PROJECT ? 'New project — the folder is created when you send' : `Code mode in ${root}`) : 'Code mode: Qwen works inside a project folder. It reads files on its own and asks before editing files or running commands.';
  if (root) {
    if (!document.querySelector('.composer.talking, .composer.recording'))
      els.input.placeholder = current ? 'Reply to Qwen…' : root === NEW_PROJECT ? 'What should we build?' : `What should we do in ${baseName(root)}?`;
    $('#disclaimer').textContent = 'Code mode: Qwen asks before editing files or running commands. Read each request before you allow it.';
    $('#privacy-line').textContent = root === NEW_PROJECT
      ? 'Describe what to build. Qwen creates a new folder in ~/QwenProjects and asks before it writes files or runs commands.'
      : `Code mode in ${root} — Qwen reads files on its own and asks before it edits anything or runs a command.`;
  } else updatePrivacyText();
}

async function pickCodeFolder() {
  toast('Choose a project folder in the window that just opened…');
  try {
    const { root, error } = await codePost('/code/pick');
    if (error) return toast(error);
    if (!root) return null;
    const ok = await codePost('/code/check', { root });
    if (ok.error) { toast(ok.error); return null; }
    return ok.root;
  } catch (e) { toast(e.message); return null; }
}

function setCodeRoot(root) {
  if (current) { current.code = { ...(current.code || {}), root }; save(); }
  else codeDraft = root;
  updateCodeUI();
  els.input.focus();
}
async function openCodeFolder() {
  const root = await pickCodeFolder();
  if (root) setCodeRoot(root);
}
async function enterCode() {
  const root = await pickCodeFolder();
  if (!root) return;
  if (current) { current.code = { ...(current.code || {}), root }; save(); }
  else codeDraft = root;
  updateCodeUI();
  els.input.focus();
}
function leaveCode() {
  if (current) { delete current.code; save(); } else codeDraft = null;
  updateCodeUI();
}
$('#code-btn').onclick = (e) => {
  e.stopPropagation();
  if (e.target.closest('#code-off')) return leaveCode();
  // First click: start a new project straight away. Once on, the button opens the menu.
  if (!codeRootNow()) return setCodeRoot(NEW_PROJECT);
  $('#code-menu').classList.toggle('open');
};
$('#code-menu').onclick = async (e) => {
  const b = e.target.closest('[data-code]');
  if (!b) return;
  $('#code-menu').classList.remove('open');
  const act = b.dataset.code;
  if (act === 'new') setCodeRoot(NEW_PROJECT);
  else if (act === 'open') openCodeFolder();
  else if (act === 'off') leaveCode();
  else if (act === 'reveal') { const r = await codePost('/code/reveal', { root: codeRootNow() }); if (r.error) toast(r.error); }
};
addEventListener('click', (e) => { if (!e.target.closest('#code-menu, #code-btn')) $('#code-menu').classList.remove('open'); });
$('#nav-code').onclick = () => { newChat(); setCodeRoot(NEW_PROJECT); };

// Keep the Code UI in step with whichever chat is open
{
  const renderListBase = renderList;
  renderList = function () { renderListBase(); updateCodeUI(); };
  const newChatBase = newChat;
  newChat = function () { codeDraft = null; newChatBase(); };
}
$('#new-chat').onclick = () => newChat();

function codeSystemPrompt(root) {
  return `You are Qwen, a careful coding agent working on the user's Mac (zsh) inside this project folder:
${root}
${settings.shareTime !== false ? dateTimeContext() + '\n' : ''}
Use the tools to do real work in the folder. Paths are relative to the project folder.

How to work:
0. For any task with more than two steps, your FIRST tool call must be update_plan. Mark steps done as you finish them.
1. Look before you change anything: list_files to see the layout, search to find where things are, read_file on the files involved.
2. Make focused changes with edit_file. old_string must be copied exactly from read_file output, without the line-number prefix. Use write_file only for new files or complete rewrites.
3. After changing code, check it: run the program, its tests or a quick command with run_command, read the output, and fix anything that fails.
4. The user approves every edit and command. If they decline one, do not repeat it — explain and ask what they would prefer.
5. Never run destructive or outward-facing commands (rm -rf, git reset --hard, git push, sudo, deleting data) unless the user explicitly asked for exactly that.
   Never install or upgrade software, packages or tools (brew, pip, npm install, etc.). If something you need is missing (for example pytest), stop and tell the user what is missing and the command they could run — do not work around it by installing things.
   Use python3, not python.
6. Keep any text between tool calls to one short sentence. If the user only asks a question, answer it (reading files as needed) without editing.
6b. If the folder is empty you are starting a new project: plan briefly, then create the files with write_file (one file per call, complete content, no placeholders). For a website or small app, prefer a single self-contained index.html (HTML, CSS and JavaScript in one file, no build step) unless the user asks otherwise. Then check your work, for example run a Python file, or read back what you wrote.
6c. Long or research-style tasks (reproducing a paper, analysing data):
   - Start with update_plan. Keep NOTES.md in the folder up to date with key facts, decisions, file locations and numbers — your memory of older steps gets trimmed, so write things down and re-read NOTES.md when unsure.
   - Read the paper's methods carefully (read_file works on PDFs) and follow them exactly. Never silently change the method, sample or settings to make code run; if you must deviate, say so and record it in NOTES.md.
   - Find data and code with web_search / web_fetch, and fetch files with download_file.
   - Only call something verified or matching if a tool output in this conversation actually shows it. If a check failed or could not be run (missing package, page without the numbers), say so plainly — never fill in "published" values from memory.
   - Be sceptical of your own results: check sample sizes, missing data, value ranges, and whether results are plausible; check the defaults of statistical functions that can silently change results; compare every number with the paper and report differences explicitly rather than explaining them away.
   - Python is python3; R is available as Rscript. Save analysis code in script files (not only one-off commands) so results can be re-run.
7. When finished, reply with a short summary: what you created or changed (file names), the full folder path, how to open or run it, how you checked it, and anything left to do.${(settings.systemPrompt || '').trim() ? '\n\nThe user\'s custom instructions:\n' + settings.systemPrompt.trim() : ''}`;
}

function codeCtx(messages) {
  const chars = messages.reduce((n, m) => n + (m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  const need = chars / 3 + 8192;
  const max = modelCaps[els.model.value + ':ctx'] || 40960;
  for (const tier of [32768, 65536]) if (need <= tier) return Math.min(tier, max);
  return Math.min(max, 65536);  // larger windows need far more memory than this Mac should spend
}

// Long tasks: keep the newest tool outputs in full and shrink older ones, so the
// conversation fits the model's memory. NOTES.md and the plan carry the important facts.
function trimCodeHistory(history) {
  const toolIdx = history.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const size = () => history.reduce((n, m) => n + (m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  const budget = 65536 * 3 * 0.6;  // ~60% of a 64k-token window, in characters
  for (const keep of [10, 6, 3]) {
    if (size() <= budget) return;
    for (const i of toolIdx.slice(0, -keep)) {
      const c = history[i].content || '';
      if (c.length > 700) history[i] = { ...history[i], content: c.slice(0, 500) + `\n… [older output trimmed to save memory; ${c.length} chars originally — re-run the tool if you need it]` };
    }
  }
}

// Sometimes the model writes a tool call as text instead of a real call. Recover the two
// formats Qwen uses: JSON {"name","arguments"} and <function=name><parameter=k>v</parameter>.
function parseTextToolCalls(text, tools = CODE_TOOLS) {
  const known = new Set(tools.map((t) => t.function.name)), out = [];
  for (const m of text.matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*(?:<\/tool_call>|$)/g)) {
    try { const j = JSON.parse(m[1]); if (known.has(j.name)) out.push({ function: { name: j.name, arguments: j.arguments || j.parameters || {} } }); } catch {}
  }
  for (const m of text.matchAll(/<function=([\w-]+)>([\s\S]*?)(?:<\/function>|$)/g)) {
    if (!known.has(m[1])) continue;
    const args = {};
    for (const p of m[2].matchAll(/<parameter=([\w-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
      let v = p[2];
      if (/^(true|false|-?\d+(\.\d+)?|\[[\s\S]*\]|\{[\s\S]*\})$/.test(v.trim())) { try { v = JSON.parse(v.trim()); } catch {} }
      args[p[1]] = v;
    }
    out.push({ function: { name: m[1], arguments: args } });
  }
  return out;
}

// One model turn, streamed. Returns { content, tool_calls }.
async function codeTurn(history, msg, paint, signal, tools = CODE_TOOLS) {
  const caps = modelCaps[els.model.value] || [];
  const think = !!settings.think && caps.includes('thinking');
  const num_ctx = codeCtx(history);
  const options = { num_ctx };
  if (think) {  // same thinking budget as chat, if the window has room for it
    const used = history.reduce((n, m) => n + (m.content || '').length, 0) / 3;
    options.num_predict = Math.max(1024, Math.min(THINK_BUDGET, Math.floor(num_ctx - used - 1024)));
  }
  const res = await fetch('/api/chat', {
    method: 'POST', signal,
    body: JSON.stringify({ model: els.model.value, messages: history, tools, stream: true, think, options }),
  });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
  const step = { type: 'text', content: '' };
  msg.steps.push(step);
  const calls = [];
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', frame = null, thinking = '', last = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      if (data.message?.thinking) { msg.liveThinking = true; thinking += data.message.thinking; }
      if (data.message?.content) { step.content += data.message.content; msg.liveThinking = false; }
      if (data.message?.tool_calls) calls.push(...data.message.tool_calls);
      if (data.done && data.eval_count && data.eval_duration) msg.tps = (data.eval_count / (data.eval_duration / 1e9)).toFixed(1);
      if (data.done) last = data;
    }
    if (!frame) frame = requestAnimationFrame(() => { frame = null; paint(); });
  }
  if (frame) cancelAnimationFrame(frame);
  msg.liveThinking = false;
  // Rescue (as in chat): thinking used its whole budget with no answer and no tool call
  if (think && last?.done_reason === 'length' && !step.content.trim() && !calls.length && thinking.trim()) {
    msg.rescued = true; paint();
    await streamChat({ model: els.model.value, messages: rescueMessages(history, thinking), stream: true, think: false,
                       options: { num_ctx: Math.max(16384, num_ctx), num_predict: RESCUE_TOKENS } }, signal, (data) => {
      if (data.message?.content) { step.content += data.message.content; paint(); }
    });
  }
  if (!calls.length) calls.push(...parseTextToolCalls(step.content, tools));
  step.content = step.content.replace(/<\/?tool_call>[\s\S]*$/, '').replace(/<function=[\s\S]*$/, '').trim();  // leaked tool-call markup
  if (!step.content) msg.steps.pop();
  return { content: step.content, tool_calls: calls };
}

function askApproval(st, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('stopped', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    st._resolve = (v) => { signal.removeEventListener('abort', onAbort); delete st._resolve; resolve(v); };
  });
}

async function codeTool(chat, st, paint, signal) {
  if (SKILL_TOOL_NAMES.has(st.name)) return skillTool(st, paint, 'code');
  if (st.name === 'update_plan') {
    let steps = st.args?.steps;
    if (typeof steps === 'string') { try { steps = JSON.parse(steps); } catch { steps = null; } }
    if (!Array.isArray(steps) || !steps.length) { st.status = 'error'; st.result = 'steps must be a non-empty list'; paint(); return 'Error: steps must be a non-empty list of {step, status}'; }
    st.plan = steps.slice(0, 30).map((x) => ({ step: String(x.step ?? x.content ?? x).slice(0, 200), status: ['done', 'in_progress'].includes(x.status) ? x.status : 'pending' }));
    chat.code.plan = st.plan; save();
    st.status = 'done'; paint();
    const done = st.plan.filter((x) => x.status === 'done').length;
    return done === st.plan.length
      ? 'Plan saved: every step is done. Do not call update_plan again. If the work is checked, reply to the user now with your final summary (no more tool calls).'
      : `Plan saved (${done}/${st.plan.length} done). Continue with the next step.`;
  }
  const root = chat.code.root, kind = CODE_APPROVAL[st.name];
  const fail = (e) => { st.status = 'error'; st.result = e; paint(); return `Error: ${e}`; };
  let r;
  if (!kind) {
    r = await codePost('/code/tool', { root, name: st.name, args: st.args });
  } else {
    const pre = await codePost('/code/tool', { root, name: st.name, args: st.args, dry_run: true });
    if (pre.error) return fail(pre.error);
    st.preview = pre.preview;
    st.risky = st.name === 'run_command' && riskyCommand(st.args?.command);
    if (!chat.code.allow?.[kind] || st.risky) {
      st.status = 'ask'; paint();
      const answer = await askApproval(st, signal);
      if (answer === 'deny') { st.status = 'denied'; paint(); return 'The user declined this action. Do not try it again; ask what they would like instead.'; }
      if (answer === 'always') { chat.code.allow = { ...(chat.code.allow || {}), [kind]: true }; save(); }
    }
    st.status = 'running'; paint();
    r = await codePost('/code/tool', { root, name: st.name, args: st.args, dry_run: false });
  }
  if (r.error) return fail(r.error);
  st.status = 'done'; st.result = r.result; paint();
  return r.result;
}

// Before the agent starts, have the model break the request into steps (JSON), so long
// tasks always begin with a visible plan that stays in its instructions.
async function codePlanFirst(chat, msg, paint, signal) {
  const ask = chat.messages.filter((m) => m.role === 'user').at(-1)?.content || '';
  if (ask.trim().length < 40 || /^(continue|go on|keep going|yes|ok)\b/i.test(ask.trim())) return;
  msg.planning = true; paint();
  try {
    const prior = chat.code.plan?.length ? `Current plan:\n${chat.code.plan.map((x) => `- [${x.status}] ${x.step}`).join('\n')}\n\n` : '';
    const j = await ollamaChat({
      messages: [
        { role: 'system', content: 'You plan coding and research tasks for an agent that can read/write files, run commands, search the web and download files in a project folder. Reply with JSON only: {"steps": ["short step", ...]} with 2 to 8 concrete steps in order. If the request is a simple question or a single small action, reply {"steps": []}.' },
        { role: 'user', content: `${prior}Project folder: ${chat.code.root}\n\nRequest:\n${ask.slice(0, 4000)}` },
      ],
      format: 'json', options: { num_ctx: 8192, temperature: 0.2 },
    }, signal);
    const steps = (JSON.parse(j.message?.content || '{}').steps || []).map((x) => String(x?.step ?? x).trim()).filter(Boolean).slice(0, 10);
    if (steps.length >= 2) {
      const plan = steps.map((step, k) => ({ step: step.slice(0, 200), status: k === 0 ? 'in_progress' : 'pending' }));
      chat.code.plan = plan; save();
      msg.steps.push({ type: 'tool', name: 'update_plan', args: {}, plan, status: 'done' });
    }
  } catch (err) { if (err.name === 'AbortError') throw err; }
  delete msg.planning; paint();
}

async function generateCode({ branches, prev } = {}) {
  const chat = current;
  const msg = { role: 'assistant', content: '', model: els.model.value, time: Date.now(), steps: [], trail: [] };
  const div = addMessage({ role: 'assistant', content: '' });
  controller = new AbortController();
  const signal = controller.signal;
  startRun(chat, div);
  setSendState();
  const paint = () => { if (current === chat) { renderCode(div, msg, true); scrollDown(); } };
  paint(); scrollDown(true);

  if (chat.code.root === NEW_PROJECT) {
    const first = chat.messages.find((m) => m.role === 'user')?.content || chat.title;
    const r = await codePost('/code/new', { name: first }).catch((e) => ({ error: e.message }));
    if (r.error) { msg.error = `Couldn't create the project folder: ${r.error}`; }
    else { chat.code.root = r.root; msg.created = r.root; save(); if (current === chat) updateCodeUI(); }
  }
  const skillPart = await skillsPromptPart(chat, 'code');
  const history = [{ role: 'system', content: codeSystemPrompt(chat.code.root) + skillPart }];
  for (const m of chat.messages) {
    if (m.role === 'assistant' && m.trail) { history.push(...m.trail); if (m.content) history.push({ role: 'assistant', content: m.content }); }
    else history.push(toApi(m));
  }
  const started = Date.now();
  try {
    if (msg.error) throw new Error(msg.error);
    const caps = modelCaps[els.model.value];
    if (caps && !caps.includes('tools')) throw new Error(`${els.model.value} can't use tools, so it can't work in Code mode. Pick a qwen3-coder model in the menu below.`);
    await codePlanFirst(chat, msg, paint, signal);
    let finished = false, lastKey = '', repeats = 0;
    for (let i = 0; i < CODE_MAX_STEPS && !finished; i++) {
      trimCodeHistory(history);
      if (chat.code.plan?.length) {
        const plan = chat.code.plan.map((x) => `- [${x.status === 'done' ? 'x' : x.status === 'in_progress' ? '>' : ' '}] ${x.step}`).join('\n');
        history[0] = { role: 'system', content: codeSystemPrompt(chat.code.root) + skillPart + `\n\nYour current plan (update it with update_plan as you go):\n${plan}` };
      }
      const turn = await codeTurn(history, msg, paint, signal, [...CODE_TOOLS, ...SKILL_TOOLS]);
      if (!turn.tool_calls.length) { msg.content = turn.content; finished = true; break; }
      const am = { role: 'assistant', content: turn.content, tool_calls: turn.tool_calls };
      history.push(am); msg.trail.push(am);
      for (const tc of turn.tool_calls) {
        let args = tc.function?.arguments ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        const name = tc.function?.name || '?';
        // Loop guard: the same call over and over means the model is stuck
        const key = name + JSON.stringify(args);
        repeats = key === lastKey ? repeats + 1 : 0; lastKey = key;
        if (repeats >= 2) {
          const tm = { role: 'tool', tool_name: name, content: 'You just made this exact call already. Stop repeating it: either do something different or give the user your final answer now.' };
          history.push(tm); msg.trail.push(tm);
          if (repeats >= 4) { finished = true; msg.content = turn.content || '*(Qwen got stuck repeating the same step, so I stopped it. Say "continue" to try again.)*'; }
          continue;
        }
        const st = { type: 'tool', name, args, status: 'running' };
        msg.steps.push(st); paint();
        const result = await codeTool(chat, st, paint, signal);
        const tm = { role: 'tool', tool_name: st.name, content: String(result).slice(0, 12000) };
        history.push(tm); msg.trail.push(tm);
      }
    }
    if (!finished) msg.content = `*(Stopped after ${CODE_MAX_STEPS} steps — say "continue" to keep going.)*`;
  } catch (err) {
    if (err.name !== 'AbortError') msg.error = err.message;
  }
  msg.secs = Math.round((Date.now() - started) / 1000);
  for (const st of msg.steps) { delete st._resolve; if (st.status === 'running' || st.status === 'ask') st.status = 'stopped'; if (st.result) st.result = String(st.result).slice(0, 6000); }
  for (const t of msg.trail) if (t.role === 'tool') t.content = t.content.slice(0, 6000);  // keep storage small
  if (!msg.content && !msg.error) msg.content = signal.aborted ? '*(stopped)*' : '';
  if (branches) { msg.branches = branches; msg.branch = branches.length - 1; }
  chat.messages.push(msg);
  div._msg = msg;
  save();
  if (current === chat) renderCode(div, msg, false);
  controller = null;
  endRun();
  setSendState();
}

// Connector tools that send, invite or post: always shown in full and approved one by one
const CONN_WRITE = new Set(['gmail_send', 'outlook_send', 'calendar_create', 'outlook_calendar_create', 'x_post']);
const CONN_ASK = {
  gmail_send: ['Qwen wants to send this email from your Gmail.', 'Send'],
  outlook_send: ['Qwen wants to send this email from your Outlook.', 'Send'],
  calendar_create: ['Qwen wants to add this to your Google Calendar.', 'Create'],
  outlook_calendar_create: ['Qwen wants to add this to your Outlook calendar.', 'Create'],
  x_post: ['Qwen wants to post this publicly on X.', 'Post'],
};
const TOOL_ICONS = {
  list_files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
  read_file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  edit_file: ICONS.pencil,
  write_file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M12 12v6M9 15h6"/></svg>',
  web_search: ICONS.globe,
  web_fetch: ICONS.globe,
  download_file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  update_plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
  run_command: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6M12 19h8"/></svg>',
};
{
  const mail = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>';
  const cal = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  const xlogo = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 3h3.1l-6.8 7.8L21.8 21h-6.3l-4.9-6.4L5 21H1.9l7.3-8.3L1.5 3h6.4l4.4 5.9zm-1.1 16.2h1.7L7.1 4.7H5.3z"/></svg>';
  Object.assign(TOOL_ICONS, {
    gmail_search: mail, gmail_read: mail, gmail_send: mail, outlook_search: mail, outlook_read: mail, outlook_send: mail,
    calendar_events: cal, calendar_create: cal, outlook_calendar_events: cal, outlook_calendar_create: cal,
    drive_search: TOOL_ICONS.search, onedrive_search: TOOL_ICONS.search, drive_read: TOOL_ICONS.read_file, onedrive_read: TOOL_ICONS.read_file,
    x_post: xlogo, x_search: xlogo, x_my_posts: xlogo,
  });
}

function toolTitle(st) {
  const a = st.args || {}, c = (x) => `<code>${esc(String(x ?? ''))}</code>`;
  switch (st.name) {
    case 'list_files': return `List ${c(a.path || '.')}`;
    case 'read_file': return `Read ${c(a.path)}`;
    case 'read_image_text': return `Read the scan ${c(a.path)}${a.pages ? ' (pages ' + esc(String(a.pages)) + ')' : ''}`;
    case 'search': return `Search ${c(a.pattern)}${a.glob ? ' in ' + c(a.glob) : ''}`;
    case 'edit_file': return `Edit ${c(a.path)}`;
    case 'write_file': return `Write ${c(a.path)}`;
    case 'run_command': return `Run ${c(String(a.command || '').slice(0, 120))}`;
    case 'web_search': return `Search the web for ${c(a.query)}`;
    case 'web_fetch': return `Read ${c(String(a.url || '').replace(/^https?:\/\//, '').slice(0, 80))}`;
    case 'download_file': return `Download to ${c(a.path)}`;
    case 'update_plan': { const p = st.plan || []; return `Plan · ${p.filter((x) => x.status === 'done').length}/${p.length} done`; }
    case 'use_skill': return `Use the ${c(a.name)} skill`;
    case 'read_skill_file': return `Read ${c(a.path)} from the ${c(a.name)} skill`;
    case 'gmail_search': return `Search Gmail${a.query ? ' for ' + c(a.query) : ''}`;
    case 'gmail_read': return 'Read an email';
    case 'gmail_send': return `Email ${c(a.to)}${a.subject ? ': ' + c(a.subject) : ''}`;
    case 'calendar_events': return `Check Google Calendar${a.start ? ' from ' + c(a.start) : ''}`;
    case 'calendar_create': return `Add ${c(a.title)} to Google Calendar`;
    case 'drive_search': return `Search Google Drive for ${c(a.query)}`;
    case 'drive_read': return 'Read a Drive file';
    case 'outlook_search': return `Search Outlook${a.query ? ' for ' + c(a.query) : ''}`;
    case 'outlook_read': return 'Read an email';
    case 'outlook_send': return `Email ${c(a.to)}${a.subject ? ': ' + c(a.subject) : ''}`;
    case 'outlook_calendar_events': return `Check Outlook Calendar${a.start ? ' from ' + c(a.start) : ''}`;
    case 'outlook_calendar_create': return `Add ${c(a.title)} to Outlook Calendar`;
    case 'onedrive_search': return `Search OneDrive for ${c(a.query)}`;
    case 'onedrive_read': return 'Read a OneDrive file';
    case 'x_post': return `Post on X: ${c(String(a.text || '').slice(0, 60))}`;
    case 'x_search': return `Search X for ${c(a.query)}`;
    case 'x_my_posts': return 'Read your recent posts on X';
    default: return esc(st.name);
  }
}

function colorDiff(text) {
  return esc(text).split('\n').map((l) =>
    /^(\+\+\+|---)/.test(l) ? `<span class="hunk">${l}</span>`
      : l.startsWith('+') ? `<span class="add">${l}</span>`
      : l.startsWith('-') ? `<span class="del">${l}</span>`
      : l.startsWith('@@') ? `<span class="hunk">${l}</span>` : l + '\n').join('');
}

function toolCard(st, i, open) {
  const state = { running: '<span class="spinner"></span>', done: '✓', error: 'failed', denied: 'declined', ask: 'needs approval', stopped: 'stopped' }[st.status] || '';
  let body = '';
  if (st.plan) body += `<ul class="plan">${st.plan.map((x) => `<li class="${x.status}">${x.status === 'done' ? '✓' : x.status === 'in_progress' ? '▸' : '○'} ${esc(x.step)}</li>`).join('')}</ul>`;
  if (st.preview && CONN_WRITE.has(st.name)) body += `<pre class="conn-preview">${esc(st.preview)}</pre>`;
  else if (st.preview && st.name === 'download_file') body += `<pre>${esc(st.preview)}</pre>`;
  else if (st.preview && st.name !== 'run_command') body += `<pre>${colorDiff(st.preview)}</pre>`;
  if (st.name === 'run_command' && st.status === 'ask') body += `<pre>$ ${esc(String(st.args?.command || ''))}</pre>`;
  if (st.result && (!['edit_file', 'write_file', 'update_plan'].includes(st.name) || st.status === 'error')) body += `<pre>${esc(String(st.result))}</pre>`;
  if (st.status === 'ask' && CONN_WRITE.has(st.name)) {
    // Sending, inviting or posting: always the owner's explicit call, never "always allow"
    const [what, verb] = CONN_ASK[st.name];
    body += `<div class="approve"><span>${what}</span><button data-approve="once" data-i="${i}">${verb}</button><button data-approve="deny" data-i="${i}">Don’t ${verb.toLowerCase()}</button></div>`;
  } else if (st.status === 'ask') {
    const kind = CODE_APPROVAL[st.name];
    body += `<div class="approve"><span>${st.name === 'download_file' ? 'Qwen wants to download this file into the project folder.' : st.name === 'run_command' ? (st.risky ? '<b>Check carefully:</b> this command can install software, delete files or reach outside the project, so it always asks.' : 'Qwen wants to run this command in the project folder.') : 'Qwen wants to make this change.'}</span>
      <button data-approve="once" data-i="${i}">Allow</button>
      ${st.risky ? '' : `<button data-approve="always" data-i="${i}">Always allow ${kind} in this chat</button>`}
      <button data-approve="deny" data-i="${i}">Deny</button></div>`;
  }
  const isOpen = open || st.status === 'ask' || st.latestPlan || (st.status === 'error' && st.name !== 'read_file');
  return `<details class="tool ${st.status}" data-i="${i}"${isOpen ? ' open' : ''}><summary><span class="ticon">${TOOL_ICONS[st.name] || ''}</span><span class="tname">${toolTitle(st)}</span><span class="tstate">${state}</span></summary>${body}</details>`;
}

function renderCode(div, m, live) {
  const body = div.querySelector('.a-body');
  const open = new Set([...body.querySelectorAll('details.tool[open]')].map((d) => d.dataset.i));
  let html = m.created ? `<div class="code-live created">${TOOL_ICONS.list_files}Created <code>${esc(m.created.replace(/^\/Users\/[^/]+/, '~'))}</code></div>` : '';
  const lastPlan = m.steps.findLastIndex((x) => x.name === 'update_plan');
  m.steps.forEach((st, i) => {
    st.latestPlan = i === lastPlan;
    if (st.type === 'text') { if (st.content) html += `<div class="content">${renderMarkdown(st.content)}</div>`; }
    else html += toolCard(st, i, open.has(String(i)));
  });
  const lastText = m.steps.at(-1)?.type === 'text' ? m.steps.at(-1).content : '';
  if (!live && m.content && m.content !== lastText) html += `<div class="content">${renderMarkdown(m.content)}</div>`;
  if (m.rescued) html += `<div class="jev-note rescue-note">${RESCUE_NOTE}</div>`;
  if (m.error) html += `<div class="content error">⚠ ${esc(m.error)}</div>`;
  if (live && !m.error) {
    const waiting = m.steps.at(-1);
    if (!waiting || waiting.type === 'tool' && waiting.status === 'done' || waiting.type === 'tool' && waiting.status === 'error' || m.liveThinking)
      html += `<div class="code-live"><span class="spinner"></span>${m.planning ? 'Planning…' : m.liveThinking ? 'Thinking…' : 'Working…'}</div>`;
    else if (waiting.type === 'text') html += '<span class="cursor"></span>';
  }
  if (!live) {
    const tools = m.steps.filter((s) => s.type === 'tool').length;
    const stats = `<span class="stats">${tools} tool call${tools === 1 ? '' : 's'}${m.secs ? ` · ${m.secs < 90 ? m.secs + 's' : Math.round(m.secs / 60) + ' min'}` : ''}</span>`;
    html += `<div class="actions"><button class="copy-msg" title="Copy">${ICONS.copy}</button><button class="retry" title="Run again">${ICONS.retry}</button>${stats}</div>`;
  }
  body.innerHTML = html;
  if (!div._codeBound) {
    div._codeBound = true;
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-approve]');
      if (!b) return;
      e.preventDefault();
      div._msg?.steps?.[+b.dataset.i]?._resolve?.(b.dataset.approve);
      m.steps[+b.dataset.i]?._resolve?.(b.dataset.approve);
    });
  }
  if (!live) {
    const actions = body.querySelector('.actions');
    const v = versionSwitcher(div, m);
    if (v) { actions.prepend(v); actions.classList.add('has-versions'); }
    const t = timeEl(m);
    if (t) actions.appendChild(t);
    body.querySelector('.copy-msg').onclick = (e) => copyText(m.content, e.currentTarget, false);
    body.querySelector('.retry').onclick = () => regenerate(div);
  }
}
