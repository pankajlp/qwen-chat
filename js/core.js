// Basics: icons, storage, markdown, sidebar, messages, times, versions of edited/regenerated messages.
// Loaded in order by index.html; all files share one global scope (classic scripts).
const ICONS = {
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12l5 5L20 7"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12a9 9 0 0115.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 01-15.5 6.3L3 16M3 21v-5h5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16v4zM13.5 6.5l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>',
};

const $ = (s) => document.querySelector(s);
const els = {
  list: $('#chat-list'), search: $('#search'), messages: $('#messages'), empty: $('#empty'), scroll: $('#scroll'),
  input: $('#input'), send: $('#send'), model: $('#model'), think: $('#think-toggle'),
};

// ---------- Storage ----------
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
let chats = store.get('qc.chats', []);
let settings = store.get('qc.settings', { model: '', think: false, collapsed: false });
let current = null;       // active chat object
let controller = null;    // AbortController for streaming
// The reply being written. It keeps going when you switch chats; only Stop (in that chat) cancels it.
let liveRun = null;       // { chat, div }
const busyHere = () => !!controller && liveRun?.chat === current;
const startRun = (chat, div) => { liveRun = { chat, div }; els.messages.querySelector('.interrupted')?.remove(); renderList(); };
const endRun = () => { liveRun = null; renderList(); };
const save = () => { if (!store.set('qc.chats', chats)) toast('Browser storage is full — this chat won’t be saved. Delete old chats with large files.'); };
const saveSettings = () => store.set('qc.settings', settings);

// ---------- Markdown ----------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Links in answers open in a new tab, so the chat isn't navigated away from
if (window.DOMPurify) DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function renderMarkdown(text) {
  if (!window.marked) return '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
  const renderer = new marked.Renderer();
  renderer.code = (code, lang) => {
    // marked v12 passes (code, lang); guard for object form too
    if (typeof code === 'object') { lang = code.lang; code = code.text; }
    lang = (lang || '').split(/\s/)[0];
    let html = esc(code);
    if (window.hljs) {
      try {
        html = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value;
      } catch {}
    }
    return `<div class="code-wrap"><div class="code-head"><span>${esc(lang || 'code')}</span><button class="copy-code">${ICONS.copy}Copy</button></div><pre><code class="hljs">${html}</code></pre></div>`;
  };
  const raw = marked.parse(text, { renderer, gfm: true, breaks: false });
  return window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
}

// ---------- Sidebar ----------
// Returns null if the chat doesn't match, else { snippet } (snippet is '' for title matches)
// Every message in a chat, including other versions of edited messages
function* allMessages(list) {
  for (const m of list) {
    yield m;
    for (const tail of m.branches || []) if (tail) yield* allMessages(tail);
  }
}

function matchChat(c, q) {
  if (c.title.toLowerCase().includes(q)) return { snippet: '' };
  for (const m of allMessages(c.messages)) {
    for (const f of m.files || []) if (f.name.toLowerCase().includes(q)) return { snippet: '📎 ' + f.name };
    // Search the text without markdown symbols so previews read cleanly (fall back to raw text)
    let text = (m.content || '').replace(/```\w*|\*\*|__|`|^#+\s*|^>\s*/gm, '').replace(/\s+/g, ' ');
    let i = text.toLowerCase().indexOf(q);
    if (i < 0) { text = (m.content || '').replace(/\s+/g, ' '); i = text.toLowerCase().indexOf(q); }
    if (i >= 0) {
      const start = Math.max(0, i - 10);
      text = text.slice(start, i + q.length + 60);
      return { snippet: (start > 0 ? '…' : '') + text };
    }
  }
  return null;
}

function highlight(text, q) {
  if (!q) return esc(text);
  const lower = text.toLowerCase();
  let out = '', pos = 0, i;
  while ((i = lower.indexOf(q, pos)) >= 0) {
    out += esc(text.slice(pos, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>';
    pos = i + q.length;
  }
  return out + esc(text.slice(pos));
}

function renderList() {
  document.body.classList.toggle('has-chat', !!current);
  $('#chat-title').textContent = current ? current.title : '';
  if (!document.querySelector('.composer.talking, .composer.recording')) els.input.placeholder = current ? 'Reply to Qwen…' : 'How can I help you today?';
  const q = els.search.value.trim().toLowerCase();
  $('#search-box').classList.toggle('has-query', !!els.search.value);
  $('#list-label').textContent = q ? 'Results' : 'Recents';
  els.list.innerHTML = '';
  let shown = 0;
  for (const c of chats) {
    const hit = q ? matchChat(c, q) : { snippet: '' };
    if (!hit) continue;
    shown++;
    const item = document.createElement('div');
    item.className = 'chat-item' + (current && c.id === current.id ? ' active' : '') + (liveRun?.chat === c ? ' busy' : '');
    const label = hit.snippet
      ? `<div class="ctext"><span>${highlight(c.title, q)}</span><span class="snippet">${highlight(hit.snippet, q)}</span></div>`
      : `<span>${highlight(c.title, q)}</span>`;
    item.innerHTML = `${label}<button class="ren" title="Rename">${ICONS.pencil}</button><button class="del" title="Delete">${ICONS.trash}</button>`;
    item.onclick = () => openChat(c.id);
    item.ondblclick = (e) => { e.preventDefault(); renameChat(item, c); };
    item.querySelector('.ren').onclick = (e) => { e.stopPropagation(); renameChat(item, c); };
    item.querySelector('.del').onclick = (e) => {
      e.stopPropagation();
      if (!confirm('Delete this chat?')) return;
      if (liveRun?.chat === c) stopStreaming();  // don't keep writing into a deleted chat
      chats = chats.filter((x) => x.id !== c.id);
      save();
      if (current && current.id === c.id) newChat(); else renderList();
    };
    els.list.appendChild(item);
  }
  if (!shown && q) {
    els.list.innerHTML = `<div class="no-results">No chats match “${esc(els.search.value.trim())}”</div>`;
  }
}

function renameChat(item, c) {
  if (item.classList.contains('editing')) return;
  item.classList.add('editing');
  item.onclick = null;
  const input = document.createElement('input');
  input.value = c.title;
  input.maxLength = 100;
  item.innerHTML = '';
  item.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (commit && title && title !== c.title) { c.title = title; save(); }
    renderList();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}

function newChat() {
  current = null;  // a reply in progress elsewhere keeps going in the background
  els.messages.innerHTML = '';
  els.empty.style.display = '';
  renderList();
  setSendState();
  els.input.focus();
  if (innerWidth < 760) setCollapsed(true);
}

function openChat(id) {
  current = chats.find((c) => c.id === id);
  if (!current) return newChat();
  els.empty.style.display = 'none';
  renderMessages();
  // Coming back to a chat that's still replying: put the live reply back on screen
  if (liveRun?.chat === current && liveRun.div) els.messages.appendChild(liveRun.div);
  renderList();
  setSendState();
  els.scroll.scrollTop = els.scroll.scrollHeight;
  if (innerWidth < 760) setCollapsed(true);
}

function setCollapsed(v) {
  settings.collapsed = v; saveSettings();
  document.body.classList.toggle('collapsed', v);
}
$('#close-side').onclick = () => setCollapsed(!document.body.classList.contains('collapsed'));
$('#open-side').onclick = () => setCollapsed(false);
$('#new-chat').onclick = newChat;
els.search.addEventListener('input', renderList);
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { els.search.value = ''; renderList(); els.search.blur(); }
  else if (e.key === 'Enter') { els.list.querySelector('.chat-item')?.click(); }
});
$('#clear-search').onclick = (e) => { e.preventDefault(); els.search.value = ''; renderList(); els.search.focus(); };
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    setCollapsed(false);
    els.search.focus();
    els.search.select();
  }
});
document.querySelector('main').addEventListener('click', (e) => {
  if (innerWidth < 760 && !document.body.classList.contains('collapsed') && e.target === document.querySelector('main')) setCollapsed(true);
});

// ---------- Messages ----------
function addMessage(m) {
  const div = document.createElement('div');
  div.className = 'msg ' + m.role;
  if (m.role === 'user') {
    if (m.files?.length) {
      const files = document.createElement('div');
      files.className = 'files';
      m.files.forEach((f) => files.appendChild(fileChip(f)));
      div.appendChild(files);
    }
    if (m.content) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.content;
      div.appendChild(bubble);
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.innerHTML = `<button class="copy-msg" title="Copy">${ICONS.copy}</button><button class="edit-msg" title="Edit">${ICONS.pencil}</button>`;
    const v = versionSwitcher(div, m);
    if (v) { actions.prepend(v); actions.classList.add('has-versions'); }
    const t = timeEl(m);
    if (t) actions.appendChild(t);
    actions.querySelector('.copy-msg').onclick = (e) => copyText(m.content, e.currentTarget, false);
    actions.querySelector('.edit-msg').onclick = () => editMessage(div);
    if (!m.content) actions.querySelector('.copy-msg').remove();
    div.appendChild(actions);
  } else {
    div.innerHTML = `<div class="avatar">${ICONS.star}</div><div class="a-body"></div>`;
    updateAssistant(div, m, false);
  }
  div._msg = m;  // link the element to its stored message
  els.messages.appendChild(div);
  return div;
}

// ---------- Times ----------
function fmtTime(t) {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Yesterday ${time}`;
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
  return `${date}, ${time}`;
}
function timeEl(m) {
  if (!m.time) return null;
  const el = document.createElement('time');
  el.className = 'msg-time';
  el.dateTime = new Date(m.time).toISOString();
  el.textContent = fmtTime(m.time);
  el.title = new Date(m.time).toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' });
  return el;
}

// ---------- Versions (edited messages and regenerated replies) ----------
// An edited user message keeps every version. The version on screen lives in chat.messages as usual;
// the others are stored on it as `branches` — each one is that version of the message plus the replies
// that followed it. `branch` is the index of the version on screen (its slot in `branches` is null).
const stripMeta = ({ branches, branch, ...rest }) => rest;

function versionSwitcher(div, m) {
  if (!(m.branches?.length > 1)) return null;
  const n = m.branches.length, k = m.branch;
  const v = document.createElement('span');
  v.className = 'versions';
  v.innerHTML = `<button class="prev" title="Previous version" ${k === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg></button>`
    + `<span>${k + 1} / ${n}</span>`
    + `<button class="next" title="Next version" ${k === n - 1 ? 'disabled' : ''}>${ICONS.chevron}</button>`;
  v.querySelector('.prev').onclick = () => switchVersion(div, k - 1);
  v.querySelector('.next').onclick = () => switchVersion(div, k + 1);
  return v;
}
const firstTitle = (m) => autoTitle(m.content || (m.files || []).map((f) => f.name).join(', '));

function renderMessages() {
  els.messages.innerHTML = '';
  current.messages.forEach((m) => addMessage(m));
  // Your last message has no reply (the page reloaded mid-reply): offer to run it again, never automatically
  if (current.messages.at(-1)?.role === 'user' && liveRun?.chat !== current) showInterrupted();
}

function showInterrupted() {
  const bar = document.createElement('div');
  bar.className = 'interrupted';
  bar.innerHTML = '<span>Qwen didn’t finish replying to this (the page reloaded or the reply was cut off).</span><button class="btn">Retry</button>';
  bar.querySelector('button').onclick = () => {
    if (controller) return toast(`Qwen is still answering in “${liveRun?.chat?.title || 'another chat'}”. Wait for it to finish first.`);
    bar.remove(); generate();
  };
  els.messages.appendChild(bar);
}

function switchVersion(div, k) {
  if (controller) return toast('Wait for the reply to finish, or press Stop');
  const m = div._msg, i = current.messages.indexOf(m), b = m.branches;
  if (i < 0 || !b || k < 0 || k >= b.length || k === m.branch) return;
  const autoNamed = i === 0 && current.title === firstTitle(m);
  b[m.branch] = [stripMeta(m), ...current.messages.slice(i + 1)];  // stash the version on screen
  const tail = b[k];
  b[k] = null;
  const first = { ...tail[0], branches: b, branch: k };
  current.messages = [...current.messages.slice(0, i), first, ...tail.slice(1)];
  if (autoNamed) current.title = firstTitle(first);
  save();
  // Re-render, keeping the switched message where it was on screen
  const top = div.getBoundingClientRect().top;
  renderMessages();
  renderList();
  const same = els.messages.children[i];
  if (same) els.scroll.scrollTop += same.getBoundingClientRect().top - top;
}

function editMessage(div) {
  if (controller) return toast('Wait for the reply to finish, or press Stop');
  const m = div._msg;
  if (!current || current.messages.indexOf(m) < 0 || div.querySelector('.edit-box')) return;
  const idx = current.messages.indexOf(m);
  const bubble = div.querySelector('.bubble'), actions = div.querySelector('.actions');
  const box = document.createElement('div');
  box.className = 'edit-box';
  box.innerHTML = `<textarea rows="1"></textarea><div class="edit-row">
    <span class="note">The current version will be kept — use ‹ › to switch back</span>
    <button class="btn cancel">Cancel</button><button class="btn primary send-edit">Send</button></div>`;
  const ta = box.querySelector('textarea');
  ta.value = m.content;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  if (bubble) bubble.replaceWith(box); else actions.before(box);
  actions.style.display = 'none';
  grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);

  const cancel = () => { if (bubble) box.replaceWith(bubble); else box.remove(); actions.style.display = ''; };
  const submit = async () => {
    const text = ta.value.trim();
    if (!text && !m.files?.length) return ta.focus();
    if (text === m.content) return cancel();
    if (controller) return toast('Wait for the reply to finish, or press Stop');
    const i = current.messages.indexOf(m);
    if (i < 0) return cancel();
    // Stash the current version (with its replies) and add the edit as a new version
    const b = m.branches || [null];
    b[m.branches ? m.branch : 0] = [stripMeta(m), ...current.messages.slice(i + 1)];
    b.push(null);
    const edited = { ...stripMeta(m), content: text, time: Date.now(), branches: b, branch: b.length - 1 };
    if (i === 0 && current.title === firstTitle(m)) current.title = firstTitle(edited);
    current.messages = [...current.messages.slice(0, i), edited];
    save();
    renderMessages();
    renderList();
    scrollDown(true);
    await generate();
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  box.querySelector('.cancel').onclick = cancel;
  box.querySelector('.send-edit').onclick = submit;
}

function updateAssistant(div, m, live) {
  if (m.steps) return renderCode(div, m, live);
  const body = div.querySelector('.a-body');
  let html = '';
  if (m.thinking) {
    const label = live && !m.content ? 'Thinking' : `Thought for ${m.thinkSecs ?? '?'}s`;
    const openAttr = body.querySelector('.think')?.open ? ' open' : '';
    html += `<details class="think${live && !m.content ? ' thinking-live' : ''}"${openAttr}><summary>${ICONS.chevron}<span>${label}</span></summary><div class="think-text">${esc(m.thinking.trim())}</div></details>`;
  }
  if (m.route && !live) html += routeLine(m.route, m);
  if (!live && m.consistency && m.consistency.agree < CONSIST_OK) html += consistWarning(m.consistency);
  if (m.webNote) html += `<div class="web-note">${ICONS.globe}${esc(m.webNote)}</div>`;
  if (m.jevNote) html += `<div class="jev-note">${esc(m.jevNote)}</div>`;
  if (m.rescued) html += `<div class="jev-note rescue-note">${RESCUE_NOTE}</div>`;
  if (m.error) html += `<div class="content error">⚠ ${esc(m.error)}</div>`;
  else if (m.jev) html += jevCard(m.jev);
  else if (live && m.status) html += `<div class="jev-live"><span class="spinner"></span>${esc(m.status)}</div>`;
  else if (m.content) html += `<div class="content">${linkCitations(renderMarkdown(m.content), m.sources)}</div>`;
  if (!live && m.sources?.length) html += sourcesList(m.sources);
  if (live && m.verifyStatus) html += `<div class="verify-live"><span class="spinner"></span>${esc(m.verifyStatus)}</div>`;
  if (!live && (m.memUsed?.length || m.memSaved?.length)) html += memoryLine(m);
  if (!live && m.consistency) html += consistPanel(m.consistency);
  if (!live && (m.checks || m.verifyError)) html += checksPanel(m);
  if (live && !m.error && !m.status && !m.verifyStatus && !(m.thinking && !m.content)) html += '<span class="cursor"></span>';
  if (!live) {
    const stats = m.jev ? `<span class="stats">${m.jev.passes} passes · ${(m.jev.ms / 1000).toFixed(1)}s</span>` : m.tps ? `<span class="stats">${m.tps} tok/s</span>` : '';
    html += `<div class="actions"><button class="copy-msg" title="Copy">${ICONS.copy}</button><button class="retry" title="Regenerate">${ICONS.retry}</button>${stats}</div>`;
  }
  body.innerHTML = html;
  if (!live && m.checks?.length) highlightClaims(body.querySelector(':scope > .content'), m);
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

function copyText(text, btn, withLabel) {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.innerHTML;
    btn.innerHTML = ICONS.check + (withLabel ? 'Copied' : '');
    setTimeout(() => (btn.innerHTML = old), 1500);
  });
}
els.messages.addEventListener('click', (e) => {
  const b = e.target.closest('.copy-code');
  if (b) copyText(b.closest('.code-wrap').querySelector('code').innerText, b, true);
});
