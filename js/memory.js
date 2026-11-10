// Memory: facts Qwen remembers about you, stored in this browser.
// Loaded in order by index.html; all files share one global scope (classic scripts).
// ---------- Memory (private, in this browser) ----------
// After each of your messages, a quick Jev yes/no decides whether it told Qwen something lasting about
// you; if so, Qwen writes it down as a short fact (updating an older fact on the same topic rather than
// duplicating it). Before each answer, Qwen shortlists memories that might matter and a calibrated Jev
// check keeps only the ones that would actually change the answer. Nothing leaves your browser.
const MEM_MAX = 200;
let memories = store.get('qc.memories', []);
const saveMemories = () => { if (!store.set('qc.memories', memories)) toast('Browser storage is full — memories couldn’t be saved.'); };
const memOn = () => settings.memory !== false;
const memId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const trimMemories = () => { if (memories.length > MEM_MAX) memories.splice(0, memories.length - MEM_MAX); };

const MEM_EXTRACT_PROMPT = 'From the user\'s message below, extract facts about the user worth remembering in future conversations. Write each as one short sentence in the third person, starting "The user" (e.g. "The user is vegetarian."). Only include what the user states about themselves or explicitly asks you to remember. Skip one-off requests, temporary situations, and sensitive details (health, medical conditions, weight, finances, religion, politics, passwords, ID numbers) unless the user explicitly asks you to remember them. Reply with JSON only; use an empty list if there is nothing.';
const MEM_SCHEMA = {
  type: 'object',
  properties: { memories: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, replaces: { type: 'integer' } }, required: ['text', 'replaces'] } } },
  required: ['memories'],
};

async function jevYes(question, signal) {
  const lp = await scoreOptions({ question, options: ['Yes', 'No'], num_ctx: 4096, signal });
  return Math.exp(lp[0] - logSumExp(lp));
}
// Word overlap between two facts, ignoring "user" (every memory starts "The user…")
const memTokens = (t) => new Set(sigTokens(t).filter((w) => !/^users?$/.test(w)));
const tokenOverlap = (a, b) => {
  const ta = memTokens(a), tb = memTokens(b);
  if (!ta.size || !tb.size) return 0;
  let n = 0; for (const t of ta) if (tb.has(t)) n++;
  return n / Math.min(ta.size, tb.size);
};

// Sensitive details are never saved unless you explicitly ask Qwen to remember them. Two independent
// checks, so this doesn't rely on the model following an instruction: a keyword list and a Jev yes/no.
const SENSITIVE_WORDS = /\b(weigh\w*|kg|kgs|lbs|pounds|bmi|diabet\w*|cancer|tumou?r|hiv|depress\w*|anxiety|adhd|autis\w*|disorder|disease|illness|medic\w*|medication|diagnos\w*|therap\w*|pregnan\w*|surgery|blood pressure|cholesterol|salary|income|debt|loan|mortgage|bank|account number|credit|password|passcode|pin|otp|aadhaar|pan card|ssn|social security|passport|religio\w*|caste|politic\w*|vote[sd]?|sexual\w*|gay|lesbian|bisexual|transgender)\b/i;
const SENSITIVE_Q = 'Is this a sensitive personal detail — about health, medical conditions, body weight or size, mental health, finances or income, religion, caste, politics, sexuality, or passwords and ID numbers?';

async function learnFromTurn(userText, msg, chat) {
  try {
    if (userText.trim().length < 12) return;
    const explicit = /\bremember\b/i.test(userText);  // "please remember that…" overrides the sensitive-topic filter
    // Show what's already remembered, so a new fact on the same topic (e.g. a new city) is marked as an update
    const known = memories.slice(-80);
    const knownList = known.length ? `Already remembered:\n${known.map((m, i) => `${i + 1}. ${m.text}`).join('\n')}\n\n` : '';
    const out = await ollamaChat({
      messages: [
        { role: 'system', content: MEM_EXTRACT_PROMPT + ' For each fact, set "replaces" to the number of an already-remembered fact it updates or contradicts (same topic, e.g. where they live now, their job, a changed preference), or 0 if none. Leave out facts that are already remembered unchanged.' },
        { role: 'user', content: `${knownList}The user's message:\n${userText.slice(0, 4000)}` },
      ],
      format: MEM_SCHEMA, options: { temperature: 0 },
    });
    let facts = [];
    try { facts = JSON.parse(out.message.content).memories || []; } catch {}
    facts = facts.map((f) => ({ text: String(f?.text ?? f).trim(), old: known[(f?.replaces | 0) - 1] || null }))
      .filter((f) => f.text.length > 6 && f.text.length < 300).slice(0, 5);
    const saved = [];
    for (const { text: fact, old } of facts) {
      if (!explicit && (SENSITIVE_WORDS.test(fact) || await jevYes(`Fact about a user: "${fact}"\n\n${SENSITIVE_Q}`) >= 0.5)) continue;
      // Same topic as something already remembered? Update it rather than keep both. The candidate comes
      // from the extraction (by meaning) or, failing that, from shared words; a Jev yes/no confirms it.
      const target = (old && memories.includes(old) && old)
        || memories.map((m) => ({ m, s: tokenOverlap(fact, m.text) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s)[0]?.m;
      if (target && await jevYes(`Fact A (older): "${target.text}"\nFact B (newer): "${fact}"\n\nIs B about the same thing as A, so that B repeats, corrects or updates it (for example where they live, their job, or a preference that changed)?`) >= 0.5) {
        if (target.text.trim().toLowerCase() !== fact.toLowerCase()) {
          target.text = fact;
          target.updated = Date.now();
          saved.push({ id: target.id, text: fact, updated: true });
        }
        continue;
      }
      const m = { id: memId(), text: fact, created: Date.now(), chat: chat.id };
      memories.push(m);
      saved.push({ id: m.id, text: fact });
    }
    if (!saved.length) return;
    trimMemories();
    saveMemories();
    msg.memSaved = saved;
    save();
    const div = [...els.messages.children].find((d) => d._msg === msg);
    if (div && !controller) updateAssistant(div, msg, false);
  } catch { /* memory is best-effort */ }
}

async function recallMemories(history, latest, signal, paint, msg) {
  msg.status = 'Checking what I remember about you…'; paint();
  let candidates = memories;
  if (memories.length > 4) {
    // Shortlist (generous: indirect relevance counts, e.g. a diet for a recipe question)
    const pool = memories.slice(-80);
    const out = await ollamaChat({
      messages: [
        { role: 'system', content: 'You pick which remembered facts about the user could matter for answering their message, even indirectly (e.g. a dietary preference for a recipe, their city for a weather question, their job for career advice). Reply with JSON only: the numbers of up to 4 facts, or an empty list.' },
        { role: 'user', content: `Facts about the user:\n${pool.map((m, i) => `${i + 1}. ${m.text}`).join('\n')}\n\nTheir message:\n${latest.slice(0, 1500)}` },
      ],
      format: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } } }, required: ['ids'] },
      options: { temperature: 0 },
    }, signal);
    let ids = [];
    try { ids = JSON.parse(out.message.content).ids || []; } catch {}
    candidates = [...new Set(ids)].map((i) => pool[i - 1]).filter(Boolean).slice(0, 4);
  }
  // Keep only those that would actually change the answer
  const used = [];
  for (const m of candidates) {
    const p = await jevYes(`A fact the assistant remembers about the user: "${m.text}"\n\nThe user's latest message:\n---\n${latest.slice(0, 1500)}\n---\n\nWould taking this fact into account change or improve the answer to this message?`, signal);
    if (p >= 0.5) used.push(m);
  }
  for (const m of used) m.lastUsed = Date.now();
  if (used.length) saveMemories();
  return used;
}

function memoryLine(m) {
  const parts = [];
  if (m.memUsed?.length) parts.push(`<span class="mem-used" title="${esc(m.memUsed.map((x) => '• ' + x.text).join('\n'))}">🧠 Used ${m.memUsed.length} memor${m.memUsed.length === 1 ? 'y' : 'ies'}</span>`);
  for (const s of m.memSaved || []) {
    const still = memories.some((x) => x.id === s.id);
    parts.push(still
      ? `<span>🧠 ${s.updated ? 'Updated' : 'Remembered'}: <q>${esc(s.text)}</q> <button class="mem-forget" data-forget="${esc(s.id)}">Forget</button></span>`
      : `<span>🧠 Forgot: <s>${esc(s.text)}</s></span>`);
  }
  return `<div class="mem-line">${parts.join('<span class="sep">·</span>')}</div>`;
}

function forgetMemory(id) {
  memories = memories.filter((m) => m.id !== id);
  saveMemories();
}
els.messages.addEventListener('click', (e) => {
  const b = e.target.closest('[data-forget]');
  if (!b) return;
  forgetMemory(b.dataset.forget);
  const div = b.closest('.msg');
  if (div?._msg) updateAssistant(div, div._msg, false);
  toast('Forgotten');
});

function renderMemorySettings() {
  $('#mem-on').checked = memOn();
  const list = $('#mem-list');
  list.innerHTML = '';
  for (const m of [...memories].reverse()) {
    const row = document.createElement('div');
    row.className = 'mem-item';
    row.innerHTML = `<span></span><button type="button" title="Forget this">×</button>`;
    row.querySelector('span').textContent = m.text;
    row.querySelector('button').onclick = () => { forgetMemory(m.id); renderMemorySettings(); };
    list.appendChild(row);
  }
  $('#mem-count').textContent = memories.length ? `${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}, only in this browser` : '';
  $('#mem-clear').disabled = !memories.length;
}
$('#mem-on').onchange = () => { settings.memory = $('#mem-on').checked; saveSettings(); toast(settings.memory ? 'Memory on' : 'Memory off — nothing new will be saved or used'); };
$('#mem-clear').onclick = () => {
  if (!confirm(`Forget all ${memories.length} memories? This can’t be undone.`)) return;
  memories = [];
  saveMemories();
  renderMemorySettings();
  toast('All memories forgotten');
};
