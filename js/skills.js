// Skills: /name instructions Qwen loads for particular kinds of work (server: skills.py).
// Loaded in order by index.html; all files share one global scope (classic scripts).
// ---------- Skills (qwen-chat/skills): packaged instructions for particular kinds of work ----------
// Type /name in any chat; in Code and Accounts mode Qwen can also load them itself with use_skill.
let skillsList = [];
const skillCache = new Map();
const skillOn = (name) => !(settings.skillsOff || []).includes(name);

async function loadSkillsList() {
  try { skillsList = (await (await fetch('/skills/list')).json()).skills || []; } catch { skillsList = []; }
  if ($('#skills-dlg').open) renderSkills();
}

async function loadSkill(name) {
  if (skillCache.has(name)) return skillCache.get(name);
  const j = await (await fetch(`/skills/get?name=${encodeURIComponent(name)}`)).json();
  if (j.error) throw new Error(j.error);
  skillCache.set(name, j);
  return j;
}

function slashSkill(text) {
  const m = /^\/([a-z0-9][a-z0-9-]*)(\s|$)/.exec(text || '');
  return m && skillsList.some((x) => x.name === m[1] && skillOn(x.name)) ? m[1] : null;
}

// The skill's own instructions, plus a short adapter: most were written for Claude
function skillBlock(sk, mode) {
  const tools = mode === 'chat'
    ? 'In this chat you have no tools: apply the skill as guidance in your replies. If it needs files read or code run, say that Code mode can do that.'
    : `If it names Claude tools, use these instead: Read → read_file, Write → write_file, Edit → edit_file, Bash → run_command, Grep/Glob → search/list_files, WebSearch/WebFetch → web_search/web_fetch, TodoWrite/TaskCreate → update_plan${mode === 'accounts' ? ' (in this chat you only have the account tools and the skill tools)' : ''}.`;
  const files = mode === 'chat'
    ? '\nWork only from the instructions below: in this chat you cannot open other files or start sub-agents, so skip any step that needs them.'
    : sk.files?.length
    ? `\nFiles bundled with this skill (open them with read_skill_file when the instructions point to them${mode === 'code' && sk.dir ? `; its scripts can be run with run_command using their full path, e.g. python3 "${sk.dir}/scripts/<name>.py"` : ''}): ${sk.files.slice(0, 50).join(', ')}`
    : '';
  const claude = sk.source !== 'Qwen Chat' && sk.source !== 'Yours';
  return `\n\n## Skill: ${sk.name}\nFollow the "${sk.name}" skill below for this conversation.${claude ? ` It was written for Claude, so adapt it. ${tools} Where it mentions subagents, parallel agents, AskUserQuestion, plugins, hooks, MCP servers or other Claude-only features, do the work yourself step by step and ask the user questions in plain text.` : ` ${tools}`} Never install software: if a package or program it needs is missing, tell the user what to install.${sk.needs ? ` (This skill expects: ${sk.needs}.)` : ''}${files}\n\n<skill-instructions name="${sk.name}">\n${sk.body}\n</skill-instructions>`;
}

// What a chat's system prompt gets: the skill the user turned on with /name, and (in agent modes) the menu
async function skillsPromptPart(chat, mode) {
  let out = '';
  const active = [...(chat?.messages || [])].reverse().find((m) => m.role === 'user' && m.skill)?.skill;
  if (active && skillOn(active)) { try { out += skillBlock(await loadSkill(active), mode); } catch {} }
  if (mode !== 'chat') {
    const avail = skillsList.filter((x) => skillOn(x.name) && x.name !== active && (mode === 'code' || !x.tools));
    if (avail.length) out += `\n\n## Skills\nPackaged instructions for particular kinds of work. When the user's request clearly matches one, call use_skill with its name before starting, then follow it:\n${avail.map((x) => `- ${x.name}: ${x.description.slice(0, 200)}`).join('\n')}`;
  }
  return out;
}

const SKILL_TOOLS = [
  { type: 'function', function: { name: 'use_skill', description: 'Load a skill (packaged instructions for a kind of task, listed under Skills in your instructions). Returns the instructions to follow.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'skill name, e.g. tdd' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'read_skill_file', description: "Read a file bundled with a skill (reference, template, example) when the skill's instructions point to it.", parameters: { type: 'object', properties: { name: { type: 'string', description: 'skill name' }, path: { type: 'string', description: 'path inside the skill, e.g. REFERENCE.md' } }, required: ['name', 'path'] } } },
];
const SKILL_TOOL_NAMES = new Set(SKILL_TOOLS.map((t) => t.function.name));

async function skillTool(st, paint, mode) {
  const a = st.args || {};
  const fail = (e) => { st.status = 'error'; st.result = e; paint(); return `Error: ${e}`; };
  try {
    if (!skillsList.some((x) => x.name === a.name && skillOn(x.name))) return fail(`There's no skill called ${a.name}. Available: ${skillsList.filter((x) => skillOn(x.name)).map((x) => x.name).join(', ')}`);
    if (st.name === 'use_skill') {
      const sk = await loadSkill(a.name);
      st.status = 'done'; st.result = `Loaded the ${a.name} skill (${sk.body.length} characters of instructions)`; paint();
      return skillBlock(sk, mode).trim();
    }
    const j = await (await fetch(`/skills/file?name=${encodeURIComponent(a.name)}&path=${encodeURIComponent(a.path || '')}`)).json();
    if (j.error) return fail(j.error);
    st.status = 'done'; st.result = `${(j.text || '').length} characters`; paint();
    return j.text;
  } catch (e) { return fail(e.message); }
}
{
  const book = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 19V5M9 7h6M9 11h6"/></svg>';
  Object.assign(TOOL_ICONS, { use_skill: book, read_skill_file: book,
    read_image_text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M8 10h8M8 14h5"/></svg>' });
}

function renderSkills() {
  const label = { 'Matt Pocock': 'From Matt Pocock (MIT licence)', Anthropic: 'From Anthropic / Claude (Apache 2.0 licence)', 'Qwen Chat': 'Written for Qwen Chat', Yours: 'Your skills' };
  $('#skills-list').innerHTML = Object.keys(label).map((g) => {
    const rows = skillsList.filter((x) => x.source === g);
    if (!rows.length) return '';
    return `<div class="skill-group">${label[g]}</div>` + rows.map((x) => `<label class="skill-row${skillOn(x.name) ? '' : ' off'}">
      <input type="checkbox" data-skill="${esc(x.name)}"${skillOn(x.name) ? ' checked' : ''} title="Turn this skill on or off">
      <div class="skill-main"><div><span class="skill-name">/${esc(x.name)}</span>${x.tools === 'code' ? '<span class="skill-tag">best in Code mode</span>' : x.tools === 'web' ? '<span class="skill-tag">uses web search</span>' : ''}</div>
      <div class="skill-desc" title="${esc(x.description)}">${esc(x.description)}</div>
      ${x.needs ? `<div class="skill-needs">Needs extra software: ${esc(x.needs)}</div>` : ''}</div></label>`).join('');
  }).join('') || '<p>No skills found in qwen-chat/skills.</p>';
}
$('#skills-list').addEventListener('change', (e) => {
  const n = e.target.dataset.skill;
  if (!n) return;
  const off = new Set(settings.skillsOff || []);
  e.target.checked ? off.delete(n) : off.add(n);
  settings.skillsOff = [...off]; saveSettings(); renderSkills();
});
$('#profile-skills').onclick = () => { renderSkills(); $('#skills-dlg').showModal(); loadSkillsList(); };
$('#skills-close').onclick = () => $('#skills-dlg').close();

// "/" picker in the message box
const slashPop = document.createElement('div');
slashPop.id = 'slash-pop';
composerEl.appendChild(slashPop);
let slashSel = 0, slashItems = [];
function updateSlash() {
  const m = /^\/([a-z0-9-]*)$/.exec(els.input.value);
  slashItems = !m ? [] : skillsList.filter((x) => skillOn(x.name) && (x.name.startsWith(m[1]) || (m[1].length > 1 && x.name.includes(m[1]))));
  if (!slashItems.length) { slashPop.classList.remove('open'); return; }
  slashSel = Math.min(slashSel, slashItems.length - 1);
  slashPop.innerHTML = slashItems.map((x, i) => `<button type="button" data-i="${i}" class="${i === slashSel ? 'sel' : ''}"><b>/${esc(x.name)}</b><span>${esc(x.description)}</span></button>`).join('');
  slashPop.classList.add('open');
}
function pickSlash(i) {
  const x = slashItems[i];
  if (!x) return;
  els.input.value = `/${x.name} `;
  slashPop.classList.remove('open');
  autosize(); els.input.focus();
}
els.input.addEventListener('input', () => { slashSel = 0; updateSlash(); });
slashPop.addEventListener('mousedown', (e) => { const b = e.target.closest('button'); if (b) { e.preventDefault(); pickSlash(+b.dataset.i); } });
composerEl.addEventListener('keydown', (e) => {
  if (!slashPop.classList.contains('open')) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); slashSel = (slashSel + (e.key === 'ArrowDown' ? 1 : slashItems.length - 1)) % slashItems.length; updateSlash(); }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pickSlash(slashSel); }
  else if (e.key === 'Escape') { e.preventDefault(); slashPop.classList.remove('open'); }
}, true);
els.input.addEventListener('blur', () => setTimeout(() => slashPop.classList.remove('open'), 150));
loadSkillsList();
