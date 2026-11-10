// Export and import of chats.
// Loaded in order by index.html; all files share one global scope (classic scripts).
// ---------- Export ----------
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'chat';

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function chatToMarkdown(c) {
  const models = [...new Set(c.messages.map((m) => m.model).filter(Boolean))];
  let md = `# ${c.title}\n\n_Exported from Qwen Chat · ${fmtDate(Date.now())}` + (models.length ? ` · ${models.join(', ')}` : '') + '_\n';
  for (const m of c.messages) {
    md += `\n---\n\n### ${m.role === 'user' ? 'You' : 'Qwen'}${m.time ? ` · ${fmtDate(m.time)}` : ''}\n\n`;
    if (m.files?.length) md += m.files.map((f) => `📎 *${f.name}* (${fmtSize(f.size)})`).join('  \n') + '\n\n';
    if (m.thinking) md += `<details>\n<summary>Thinking (${m.thinkSecs ?? '?'}s)</summary>\n\n${m.thinking.trim()}\n\n</details>\n\n`;
    if (m.content) md += m.content.trim() + '\n';
    if (m.checks?.length) md += '\n**Fact-check**' + (m.revised ? ' (answer revised)' : '') + '\n' + m.checks.map((c) => `- ${Math.round(c.p * 100)}%${c.pBefore != null ? ` (${Math.round(c.pBefore * 100)}% before web check)` : ''} — ${c.claim}${c.evidence?.length ? ` — ${c.evidence.map((s) => s.url).join(', ')}` : ''}`).join('\n') + '\n';
    if (m.sources?.length) md += '\n**Sources**\n' + m.sources.map((s) => `${s.n}. [${s.title.replace(/[[\]]/g, '')}](${s.url})`).join('\n') + '\n';
  }
  return md;
}

function exportChat(kind) {
  if (!current) return;
  const base = `${slug(current.title)}-${fmtDate(Date.now()).slice(0, 10)}`;
  if (kind === 'md') download(base + '.md', chatToMarkdown(current), 'text/markdown');
  else if (kind === 'json') download(base + '.json', JSON.stringify({ app: 'qwen-chat', version: 1, exported: new Date().toISOString(), chats: [current] }, null, 2), 'application/json');
  else if (kind === 'print') {
    $('#print-title').textContent = current.title;
    $('#print-meta').textContent = `Qwen Chat · ${current.messages.length} messages · printed ${fmtDate(Date.now())}`;
    print();
  }
}

function exportAll() {
  if (!chats.length) return toast('No chats to export yet');
  download(`qwen-chat-backup-${fmtDate(Date.now()).slice(0, 10)}.json`,
    JSON.stringify({ app: 'qwen-chat', version: 1, exported: new Date().toISOString(), chats, memories }, null, 2), 'application/json');
  toast(`Exported ${chats.length} chat${chats.length > 1 ? 's' : ''}${memories.length ? ` and ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}` : ''}`);
}

const exportMenu = $('#export-menu');
$('#export-btn').onclick = (e) => { e.stopPropagation(); exportMenu.classList.toggle('open'); };
exportMenu.onclick = (e) => {
  const b = e.target.closest('[data-export]');
  if (!b) return;
  exportMenu.classList.remove('open');
  exportChat(b.dataset.export);
};
addEventListener('click', (e) => { if (!e.target.closest('.export')) exportMenu.classList.remove('open'); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') exportMenu.classList.remove('open'); });
$('#export-all').onclick = exportAll;

// ---------- Import ----------
const str = (v, max = Infinity) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(+v) && v !== '' && v !== null ? +v : undefined);

// Rebuild a chat from untrusted JSON, keeping only known fields with safe values
function cleanMessages(list, depth = 0) {
  const messages = [];
  for (const m of list) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const out = { role: m.role, content: str(m.content) };
    if (num(m.time) > 0) out.time = num(m.time);
    if (m.role === 'user' && Array.isArray(m.files)) {
      const files = m.files.map((f) => {
        if (!f || typeof f !== 'object') return null;
        const base = { name: str(f.name, 255) || 'file', size: num(f.size) || 0 };
        if (f.kind === 'image' && /^[A-Za-z0-9+/=]+$/.test(f.image || '')) {
          const mime = /^image\/[\w.+-]+$/.test(f.mime || '') ? f.mime : 'image/png';
          return { ...base, kind: 'image', mime, image: f.image };
        }
        return typeof f.text === 'string' ? { ...base, kind: 'text', text: f.text } : null;
      }).filter(Boolean);
      if (files.length) out.files = files;
    }
    if (m.role === 'assistant') {
      if (m.thinking) out.thinking = str(m.thinking);
      if (num(m.thinkSecs) !== undefined) out.thinkSecs = Math.round(num(m.thinkSecs));
      if (num(m.tps) !== undefined) out.tps = num(m.tps).toFixed(1);
      if (m.model) out.model = str(m.model, 100);
      const j = cleanJev(m.jev);
      if (j) out.jev = j;
      if (m.jevNote) out.jevNote = str(m.jevNote, 200);
      if (m.webNote) out.webNote = str(m.webNote, 200);
      for (const key of ['memUsed', 'memSaved']) {
        if (!Array.isArray(m[key])) continue;
        const list = m[key].slice(0, 8).filter((x) => x && typeof x.text === 'string').map((x) => ({ id: str(x.id, 40), text: str(x.text, 300), ...(x.updated ? { updated: true } : {}) }));
        if (list.length) out[key] = list;
      }
      if (m.consistency && typeof m.consistency === 'object' && Array.isArray(m.consistency.clusters)) {
        const k = Math.max(1, Math.round(num(m.consistency.k) || 1));
        const clusters = m.consistency.clusters.slice(0, 8).map((c) => ({ n: Math.max(0, Math.round(num(c?.n) || 0)), rep: str(c?.rep, 400), sameAsAnswer: !!c?.sameAsAnswer }));
        out.consistency = { k, agree: Math.min(1, Math.max(0, num(m.consistency.agree) || 0)), entropy: Math.max(0, num(m.consistency.entropy) || 0), clusters, ms: Math.round(num(m.consistency.ms) || 0) };
      }
      if (m.route && typeof m.route === 'object') {
        const rt = {};
        for (const k of ['search', 'verify', 'think', 'clarify']) rt[k] = Math.min(1, Math.max(0, num(m.route[k]) || 0));
        rt.ms = Math.round(num(m.route.ms) || 0);
        out.route = rt;
      }
      if (Array.isArray(m.checks)) {
        const checks = m.checks.slice(0, VERIFY_MAX_CLAIMS).filter((c) => c && typeof c.claim === 'string')
          .map((c) => {
            const out = { claim: str(c.claim, 500), p: Math.min(1, Math.max(0, num(c.p) || 0)) };
            if (num(c.pBefore) !== undefined) out.pBefore = Math.min(1, Math.max(0, num(c.pBefore)));
            if (Array.isArray(c.logp) && c.logp.length === 2 && c.logp.every((x) => Number.isFinite(x))) out.logp = c.logp.map(r4);
            if (typeof c.feedback === 'boolean') out.feedback = c.feedback;
            if (c.disputed) out.disputed = true;
            const ev = Array.isArray(c.evidence) ? c.evidence.slice(0, 3).filter((x) => x && /^https?:\/\//i.test(x.url || '')).map((x) => ({ title: str(x.title, 300), url: str(x.url, 2000) })) : [];
            if (ev.length) out.evidence = ev;
            return out;
          });
        if (m.checksChanged) out.checksChanged = true;
        if (m.webCheckNote) out.webCheckNote = str(m.webCheckNote, 300);
        if (checks.length) out.checks = checks;
        if (typeof m.draft === 'string' && m.revised) { out.draft = str(m.draft); out.revised = true; }
        if (num(m.calT) > 0) out.calT = num(m.calT);
      }
      if (Array.isArray(m.sources)) {
        const sources = m.sources.slice(0, 12)
          .filter((x) => x && /^https?:\/\//i.test(x.url || ''))
          .map((x, i) => ({ n: Math.round(num(x.n)) || i + 1, title: str(x.title, 300) || str(x.url, 300), url: str(x.url, 2000), read: !!x.read }));
        if (sources.length) out.sources = sources;
      }
    }
    if (Array.isArray(m.branches) && depth < 20) {
      // Keep only well-formed versions: the on-screen slot (null) plus non-empty tails starting with the same role
      const kept = [];
      let active = -1;
      m.branches.forEach((t, j) => {
        if (j === m.branch && t === null) { active = kept.length; kept.push(null); return; }
        const tail = Array.isArray(t) ? cleanMessages(t, depth + 1) : [];
        if (tail[0]?.role === m.role) kept.push(tail);
      });
      if (active >= 0 && kept.length > 1) { out.branches = kept; out.branch = active; }
    }
    if (out.content || out.files) messages.push(out);
  }
  return messages;
}

function cleanChat(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.messages)) return null;
  const messages = cleanMessages(c.messages);
  if (!messages.length) return null;
  const id = str(c.id, 64) || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const firstUser = messages.find((m) => m.role === 'user')?.content || 'Imported chat';
  return { id, title: str(c.title, 100).trim() || firstUser.slice(0, 50), messages, created: num(c.created) || Date.now() };
}

async function importFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast(`${file.name} isn’t a valid JSON file`);
  }
  // Accept a backup/export ({ chats: [...] }), a bare array of chats, or a single chat object
  const list = Array.isArray(data?.chats) ? data.chats : Array.isArray(data) ? data : data?.messages ? [data] : null;
  if (!list) return toast(`${file.name} doesn’t look like a Qwen Chat export`);

  const have = new Set(chats.map((c) => c.id));
  const added = [];
  let skipped = 0, invalid = 0;
  for (const raw of list) {
    const c = cleanChat(raw);
    if (!c) { invalid++; continue; }
    if (have.has(c.id)) { skipped++; continue; }
    have.add(c.id);
    added.push(c);
  }
  if (added.length) {
    added.sort((a, b) => b.created - a.created);
    const before = chats;
    chats = [...added, ...chats];
    if (!store.set('qc.chats', chats)) {
      chats = before;
      return toast('Not enough browser storage to import these chats. Delete some old chats and try again.');
    }
    renderList();
  }
  // Memories from a full backup: add the ones not already remembered
  let memAdded = 0;
  if (Array.isArray(data?.memories)) {
    const known = new Set(memories.map((m) => m.text.trim().toLowerCase()));
    for (const raw of data.memories.slice(0, MEM_MAX)) {
      const text = str(typeof raw === 'string' ? raw : raw?.text, 300).trim();
      if (!text || known.has(text.toLowerCase())) continue;
      known.add(text.toLowerCase());
      memories.push({ id: memId(), text, created: Math.round(num(raw?.created) || Date.now()) });
      memAdded++;
    }
    if (memAdded) { trimMemories(); saveMemories(); }
  }
  const parts = [added.length ? `Imported ${added.length} chat${added.length === 1 ? '' : 's'}` : memAdded ? 'No new chats' : 'Nothing new to import'];
  if (memAdded) parts.push(`${memAdded} memor${memAdded === 1 ? 'y' : 'ies'}`);
  if (skipped) parts.push(`${skipped} already here`);
  if (invalid) parts.push(`${invalid} unreadable`);
  toast(parts.join(' · '));
}

$('#import').onclick = () => $('#import-input').click();
$('#import-input').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
