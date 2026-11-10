// Sending messages and generating replies; composer, theme, custom instructions, settings, startup.
// Loaded in order by index.html; all files share one global scope (classic scripts).
// ---------- Sending ----------
async function send(text) {
  // Send pressed while you're talking, or before the final transcript is in: finish it first and
  // send the whole text once. (Sending the live preview right away let the transcript arrive later
  // and refill the box, so it got repeated in the next message.)
  if ((voice.rec || voice.finishing) && text === els.input.value) {
    voice.sendWhenDone = true;
    if (voice.rec) stopRecording(false);
    return;
  }
  text = text.trim();
  if (controller && !busyHere()) { toast(`Qwen is still answering in “${liveRun?.chat?.title || 'another chat'}”. Wait for it to finish, or open that chat and press Stop.`); return; }
  if (controller || pending.some((p) => p.loading)) return;
  if (!text && !pending.length) return;
  const files = pending.map(({ name, size, kind, mime, text, image }) => ({ name, size, kind, mime, text, image }));
  const title = text || files.map((f) => f.name).join(', ');
  if (!current) {
    current = { id: Date.now().toString(36), title: autoTitle(title), messages: [], created: Date.now() };
    chats.unshift(current);
    if (codeDraft) current.code = { root: codeDraft };
    els.empty.style.display = 'none';
  } else {
    chats = [current, ...chats.filter((c) => c.id !== current.id)];
  }
  const userMsg = { role: 'user', content: text, time: Date.now() };
  const skillName = slashSkill(text);  // "/tdd fix the parser" turns on the tdd skill for this chat
  if (skillName) userMsg.skill = skillName;
  if (files.length) userMsg.files = files;
  current.messages.push(userMsg);
  addMessage(userMsg);
  pending = []; renderPending();
  els.input.value = ''; autosize(); save(); renderList();
  await generate();
}

async function regenerate(div) {
  if (controller || !current) return;
  const m = div._msg, i = current.messages.indexOf(m);
  if (i < 0) return;
  // Stash this reply (and anything after it) as a version; the new reply becomes the next version
  const b = m.branches || [null];
  const prev = m.branches ? m.branch : 0;
  b[prev] = [stripMeta(m), ...current.messages.slice(i + 1)];
  b.push(null);
  current.messages = current.messages.slice(0, i);
  while (div.nextSibling) div.nextSibling.remove();
  div.remove();
  save();
  await generate({ branches: b, prev });
}

async function generate({ branches, prev } = {}) {
  if (current?.code) return generateCode({ branches, prev });
  if (settings.accounts && conn.tools.length) return generateAccounts({ branches, prev });
  const chat = current;
  const msg = { role: 'assistant', content: '', thinking: '', model: els.model.value, time: Date.now() };
  const div = addMessage({ role: 'assistant', content: '' });
  updateAssistant(div, msg, true);
  scrollDown(true);
  controller = new AbortController();
  startRun(chat, div);
  setSendState();

  const history = chat.messages.map(toApi);
  const system = [settings.shareTime !== false && dateTimeContext(), (settings.systemPrompt || '').trim()]
    .filter(Boolean).join('\n\n') + await skillsPromptPart(chat, 'chat');
  if (system.trim()) history.unshift({ role: 'system', content: system.trim() });
  const started = Date.now();
  let thinkEnd = null;
  let frame = null;
  const paint = () => { frame = null; if (current === chat) { updateAssistant(div, msg, true); scrollDown(); } };

  // Memory: bring in what you've told Qwen before, if it's relevant to this message
  const lastUserText = chat.messages.filter((m) => m.role === 'user').at(-1)?.content || '';
  if (memOn() && memories.length) {
    try {
      const used = await recallMemories(history, lastUserText, controller.signal, paint, msg);
      if (used.length) {
        msg.memUsed = used.map(({ id, text }) => ({ id, text }));
        const note = `Things you remember about the user from earlier conversations (use them only where they help; don't recite them or say you remembered unless it's natural):\n${used.map((m) => `- ${m.text}`).join('\n')}`;
        if (history[0]?.role === 'system') history[0] = { role: 'system', content: history[0].content + '\n\n' + note };
        else history.unshift({ role: 'system', content: note });
      }
    } catch (err) { if (err.name === 'AbortError') { /* stopped: the reply below is aborted too */ } }
    delete msg.status;
  }

  // Auto: decide per message whether to search, fact-check, think, or ask a clarifying question
  const auto = settings.auto !== false;
  let useWeb = settings.web, useVerify = settings.verify !== false, useThink = settings.think;
  try {
    if (auto) {
      const lastAssistant = [...chat.messages].reverse().find((m) => m.role === 'assistant');
      msg.route = await autoRoute(msg, history, controller.signal, paint, { allowClarify: !(lastAssistant?.route?.clarify >= ROUTE_THRESHOLDS.clarify) });
      ({ web: useWeb, verify: useVerify, think: useThink } = routeChoices(msg.route));
      if (msg.route.clarify >= ROUTE_THRESHOLDS.clarify) {
        useWeb = useVerify = useThink = false;
        const note = 'The user\'s latest message is ambiguous or missing key details. Instead of answering, ask one short clarifying question — offer 2 to 4 concrete options if that helps. Do not answer yet.';
        if (history[0]?.role === 'system') history[0] = { role: 'system', content: history[0].content + '\n\n' + note };
        else history.unshift({ role: 'system', content: note });
      }
    }
    if (useWeb) {
      const context = await webContext(msg, history, controller.signal, paint, auto);
      if (context) {
        if (history[0]?.role === 'system') history[0] = { role: 'system', content: history[0].content + '\n\n' + context };
        else history.unshift({ role: 'system', content: context });
      }
      delete msg.status;
      paint();
    }
    if (settings.jev && await runJev(msg, history, controller.signal, paint)) throw JEV_DONE;
    const options = useThink ? thinkOptions(history) : { num_ctx: contextSize(history) };
    const last = await streamChat({ model: els.model.value, messages: history, stream: true, think: useThink, options }, controller.signal, (data) => {
      if (data.message?.thinking) msg.thinking += data.message.thinking;
      if (data.message?.content) {
        if (msg.thinking && !thinkEnd) { thinkEnd = Date.now(); msg.thinkSecs = Math.max(1, Math.round((thinkEnd - started) / 1000)); }
        msg.content += data.message.content;
      }
      if (data.done && data.eval_count && data.eval_duration) msg.tps = (data.eval_count / (data.eval_duration / 1e9)).toFixed(1);
      if (!frame) frame = requestAnimationFrame(paint);
    });
    // Rescue: thinking used up its budget before any answer. Show the model the end of its own reasoning and
    // ask it to commit (thinking off). On the AIME benchmark this turned 6 of 13 cut-off answers into right ones.
    if (useThink && last?.done_reason === 'length' && !msg.content.trim() && msg.thinking.trim()) {
      msg.thinkSecs = Math.max(1, Math.round((Date.now() - started) / 1000));
      msg.rescued = true;
      paint();
      await streamChat({ model: els.model.value, messages: rescueMessages(history, msg.thinking), stream: true, think: false,
                         options: { num_ctx: 16384, num_predict: RESCUE_TOKENS } }, controller.signal, (data) => {
        if (data.message?.content) msg.content += data.message.content;
        if (!frame) frame = requestAnimationFrame(paint);
      });
    }
  } catch (err) {
    if (err !== JEV_DONE && err.name !== 'AbortError') msg.error = err.message;
  }
  if (frame) cancelAnimationFrame(frame);
  if (useVerify && !msg.error && !msg.jev && msg.content.trim() && !controller.signal.aborted) {
    try {
      const cs = await consistencyCheck(msg, history, controller.signal, paint);
      if (cs) msg.consistency = cs;
      await verifyAnswer(msg, history, controller.signal, paint, { web: useWeb });
    } catch (err) {
      if (msg.draft) { msg.content = msg.draft; delete msg.draft; delete msg.revised; }  // keep the full draft
      if (err.name !== 'AbortError') msg.verifyError = err.message;
    }
    delete msg.verifyStatus;
  }
  if (msg.thinking && !msg.thinkSecs) msg.thinkSecs = Math.max(1, Math.round((Date.now() - started) / 1000));
  if (!msg.content && !msg.error) msg.content = '*(stopped)*';
  msg.content = msg.content.trim();
  if (!msg.thinking) delete msg.thinking;

  if (!msg.error) {
    if (branches) { msg.branches = branches; msg.branch = branches.length - 1; }
    chat.messages.push(msg);
    div._msg = msg;
  } else if (branches) {
    // Regenerating failed: put the previous reply back instead of losing it
    branches.pop();
    const tail = branches[prev];
    branches[prev] = null;
    const first = { ...tail[0] };
    if (branches.length > 1) { first.branches = branches; first.branch = prev; }
    chat.messages.push(first, ...tail.slice(1));
  }
  save();
  if (current === chat) {
    if (msg.error && branches) {
      renderMessages();
      toast(`Couldn’t regenerate: ${msg.error}`);
    } else {
      updateAssistant(div, msg, false);
      if (msg.error) div.querySelector('.retry').onclick = () => { div.remove(); generate(); };
    }
  }
  const stopped = !!controller?.signal.aborted;  // you pressed Stop (even if part of the reply arrived)
  controller = null;
  endRun();
  setSendState();
  // Memory: learn from what you said, in the background (the reply is already done; not for a stopped reply)
  if (!msg.error && !stopped && lastUserText && memOn()) learnFromTurn(lastUserText, msg, chat);
}

function stopStreaming() { if (controller) controller.abort(); }

// Stream an Ollama /api/chat reply, calling onData for every chunk. Returns the final chunk (done_reason etc.).
async function streamChat(body, signal, onData) {
  const res = await fetch('/api/chat', { method: 'POST', signal, body: JSON.stringify(body) });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', last = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      onData(data);
      if (data.done) last = data;
    }
  }
  return last;
}

// Thinking gets a fixed token budget, and a context window with room for it on top of the conversation.
const THINK_BUDGET = 16000, RESCUE_TOKENS = 2000, RESCUE_TAIL = 12000;
function thinkOptions(history) {
  const max = modelCaps[els.model.value + ':ctx'] || 40960;
  const promptTokens = history.reduce((n, m) => n + m.content.length, 0) / 3;
  const need = promptTokens + THINK_BUDGET + 1024;
  const num_ctx = [16384, 32768].find((t) => need <= t && t <= max) || max;
  return { num_ctx, num_predict: Math.max(1024, Math.min(THINK_BUDGET, Math.floor(num_ctx - promptTokens - 1024))) };
}
// The rescue request: the same conversation, with the last question restated beside the end of the reasoning.
// (In agent loops, where tool results follow the question, the request is added as a new message instead.)
function rescueMessages(history, thinking) {
  const ask = `You were working on this and ran out of thinking time. Here is the end of your reasoning so far:\n<<<\n${thinking.slice(-RESCUE_TAIL)}\n>>>\n\n` +
    'Do not start over. Using the work above, give your best final answer now: briefly say how it follows, then state the answer clearly. ' +
    'If the reasoning had not reached an answer, give your best estimate and say it is unconfirmed.';
  const lastUser = history.map((m) => m.role).lastIndexOf('user');
  if (lastUser !== history.length - 1) return [...history, { role: 'user', content: ask }];
  const q = history[lastUser];
  return [...history.slice(0, lastUser), { ...q, content: `${q.content}\n\n${ask}` }];
}
const RESCUE_NOTE = 'Ran out of thinking time, so this answer was written from its reasoning so far. It may be less reliable.';

function scrollDown(force) {
  const s = els.scroll;
  if (force || s.scrollHeight - s.scrollTop - s.clientHeight < 150) s.scrollTop = s.scrollHeight;
}

// ---------- Composer ----------
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 240) + 'px';
  setSendState();
}
function setSendState() {
  if (busyHere()) { els.send.innerHTML = ICONS.stop; els.send.title = 'Stop'; els.send.disabled = false; }
  else {
    els.send.innerHTML = ICONS.send; els.send.title = 'Send';
    els.send.disabled = (!els.input.value.trim() && !pending.length) || pending.some((p) => p.loading);
  }
}
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(els.input.value); }
});
els.send.onclick = () => (busyHere() ? stopStreaming() : send(els.input.value));
document.querySelectorAll('#chips .chip').forEach((c) => (c.onclick = () => {
  const p = c.dataset.prompt || c.textContent;
  if (!p.endsWith(' ')) return send(p);  // a complete prompt: send it now
  els.input.value = p;                      // a starter: let the user finish the sentence
  els.input.dispatchEvent(new Event('input'));
  els.input.focus();
  els.input.setSelectionRange(p.length, p.length);
}));

// Claude-style menus: tools (in the composer) and profile (sidebar footer)
for (const [btn, menu, wrap] of [['#tools-btn', '#tools-menu', '.tools'], ['#profile-btn', '#profile-menu', '.side-foot']]) {
  $(btn).onclick = (e) => { e.stopPropagation(); $(menu).classList.toggle('open'); };
  addEventListener('click', (e) => { if (!e.target.closest(wrap)) $(menu).classList.remove('open'); });
}
$('#profile-menu').addEventListener('click', (e) => { if (e.target.closest('button')) $('#profile-menu').classList.remove('open'); });
$('#profile-settings').onclick = () => $('#settings-btn').click();
$('#nav-chats').onclick = () => { if (document.body.classList.contains('collapsed')) setCollapsed(false); els.search.focus(); };
$('#rail-search').onclick = () => { setCollapsed(false); els.search.focus(); };
// Show a dot on the tools button when thinking or Jev mode is on
new MutationObserver(() => $('#tools-btn').classList.toggle('active', !!document.querySelector('#tools-menu .toggle.on')))
  .observe($('#tools-menu'), { subtree: true, attributes: true, attributeFilter: ['class'] });
$('#tools-btn').classList.toggle('active', !!document.querySelector('#tools-menu .toggle.on'));
// Spin the spark under the reply while Qwen is answering
setInterval(() => document.body.classList.toggle('streaming', !!controller), 250);

// ---------- Theme ----------
const THEMES = {
  system: { next: 'light', label: 'Theme: System', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>' },
  light:  { next: 'dark',  label: 'Theme: Light',  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' },
  dark:   { next: 'system', label: 'Theme: Dark',  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/></svg>' },
};
function setTheme(t) {
  if (!THEMES[t]) t = 'system';
  settings.theme = t; saveSettings();
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const btn = $('#theme-btn');
  btn.innerHTML = THEMES[t].icon;
  btn.title = `${THEMES[t].label} — click for ${THEMES[t].next}`;
  btn.setAttribute('aria-label', THEMES[t].label);
}
$('#theme-btn').onclick = () => setTheme(THEMES[settings.theme || 'system'].next);

// ---------- Custom instructions ----------
// e.g. "Current date and time: Friday, 25 September 2026, 12:05 AM (Asia/Kolkata, UTC+05:30)."
function dateTimeContext(d = new Date()) {
  const date = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const off = -d.getTimezoneOffset();
  const utc = `UTC${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Current date and time: ${date}, ${time} (${zone ? zone + ', ' : ''}${utc}).`;
}

const dlg = $('#settings-dlg'), sysBox = $('#sys-prompt');
const updateSysCount = () => { $('#sys-count').textContent = `${sysBox.value.length.toLocaleString()} / 8,000`; };
const markSettingsBtn = () => {
  const on = !!(settings.systemPrompt || '').trim();
  $('#settings-btn').classList.toggle('active', on);
  $('#settings-btn').title = on ? 'Custom instructions: on' : 'Custom instructions (system prompt)';
};
$('#settings-btn').onclick = () => {
  sysBox.value = settings.systemPrompt || '';
  $('#share-time').checked = settings.shareTime !== false;
  renderCalStatus();
  renderMemorySettings();
  $('#share-time-preview').textContent = `Sent with each message, e.g. “${dateTimeContext()}”`;
  updateSysCount();
  dlg.returnValue = '';  // Esc keeps the previous returnValue, so reset it or a cancel could save
  dlg.showModal();
  sysBox.focus();
  sysBox.setSelectionRange(sysBox.value.length, sysBox.value.length);
};
sysBox.addEventListener('input', updateSysCount);
sysBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); dlg.close('save'); }
});
$('#sys-clear').onclick = () => { sysBox.value = ''; updateSysCount(); sysBox.focus(); };
document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => {
  const add = b.dataset.preset;
  if (sysBox.value.includes(add)) return;
  sysBox.value = (sysBox.value.trim() ? sysBox.value.trimEnd() + '\n' : '') + add;
  updateSysCount(); sysBox.focus();
}));
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });  // click outside
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  const before = (settings.systemPrompt || '').trim(), beforeTime = settings.shareTime !== false;
  settings.systemPrompt = sysBox.value.trim();
  settings.shareTime = $('#share-time').checked;
  saveSettings(); markSettingsBtn();
  if (settings.systemPrompt !== before) toast(settings.systemPrompt ? 'Custom instructions saved' : 'Custom instructions cleared');
  else if (settings.shareTime !== beforeTime) toast(settings.shareTime ? 'Qwen will be told the date and time' : 'Qwen won’t be told the date and time');
});

// ---------- Settings ----------
function setThink(v) { settings.think = v; saveSettings(); els.think.classList.toggle('on', v); }
function setJev(v) { settings.jev = v; saveSettings(); $('#jev-toggle').classList.toggle('on', v); }
$('#jev-toggle').onclick = () => { setJev(!settings.jev); toast(settings.jev ? 'Jev mode on — answers come back as decisions with probabilities' : 'Jev mode off'); };
els.think.onclick = () => { leaveAuto(); setThink(!settings.think); };
els.model.onchange = () => { settings.model = els.model.value; saveSettings(); };

async function loadModels() {
  const dot = $('#status-dot'), txt = $('#status-text');
  try {
    const res = await fetch('/api/tags');
    const { models = [] } = await res.json();
    if (!models.length) throw new Error('no models');
    els.model.innerHTML = models.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
    if (models.some((m) => m.name === settings.model)) els.model.value = settings.model;
    // Learn which models can see images, and their max context
    models.forEach(async (m) => {
      try {
        const info = await (await fetch('/api/show', { method: 'POST', body: JSON.stringify({ model: m.name }) })).json();
        modelCaps[m.name] = info.capabilities || [];
        const ctxKey = Object.keys(info.model_info || {}).find((k) => k.endsWith('.context_length'));
        if (ctxKey) modelCaps[m.name + ':ctx'] = info.model_info[ctxKey];
      } catch {}
    });
    dot.className = 'dot ok'; txt.textContent = 'Connected'; txt.title = `Ollama connected · ${models.length} model${models.length > 1 ? 's' : ''} available`;
  } catch {
    dot.className = 'dot bad'; txt.textContent = 'Offline'; txt.title = 'Ollama is not reachable — is it running?';
    els.model.innerHTML = '<option>qwen3:14b</option>';
  }
}

// ---------- Init ----------
const h = new Date().getHours();
$('#greeting').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
setThink(settings.think);
setJev(!!settings.jev);
setWeb(settings.web !== false);  // on unless you've turned it off
setVerify(settings.verify !== false);  // on unless you've turned it off
setAuto(settings.auto !== false);       // on unless you've turned it off
setTheme(settings.theme);
markSettingsBtn();
setCollapsed(settings.collapsed || innerWidth < 760);
setSendState();
renderList();
loadModels();
