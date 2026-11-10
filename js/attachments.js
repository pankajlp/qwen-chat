// Attaching files: text, PDF, Word, images, and reading scanned pages/photos (server: ocr.py).
// Loaded in order by index.html; all files share one global scope (classic scripts).
// ---------- Attachments ----------
const MAX_CHARS = 120000;  // per file, roughly 30k tokens
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|cfg|conf|env|log|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|pl|lua|r|m|scala|dart|sh|bash|zsh|fish|ps1|bat|sql|graphql|proto|tex|rst|srt|vtt|gitignore|dockerfile|makefile)$/i;
let pending = [];          // [{id, name, size, kind, text?, image?, loading?}]
let modelCaps = {};        // model name -> capabilities[]

const loadScript = (() => {
  const cache = {};
  return (src) => (cache[src] ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Could not load ' + src.split('/').pop() + ''));
    document.head.appendChild(s);
  }));
})();

const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || 'file').slice(0, 4);

function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3500);
}

async function extractPdf(file, item) {
  await loadScript('vendor/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [], bodies = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    let line = '', out = '';
    let lastY = null;
    for (const it of tc.items) {
      const y = it.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) { out += line.trimEnd() + '\n'; line = ''; }
      line += it.str + (it.hasEOL ? '\n' : '');
      lastY = y;
    }
    out += line;
    bodies.push(out.trim());
  }
  // Pages with (almost) no text are scans: read them from images with the vision model (owner only)
  const scanned = bodies.map((t, i) => (t.replace(/\s/g, '').length < 25 ? i + 1 : 0)).filter(Boolean);
  let note = '';
  if (scanned.length && CODE_TOKEN) {
    const pick = scanned.slice(0, OCR_MAX_PAGES);
    const r = await ocrFile(file, pick.join(','), (done, total) => setFileStatus(item, `Reading scanned page ${Math.min(done + 1, total)} of ${total}…`));
    for (const p of pick) if (r.pages[p] != null) bodies[p - 1] = r.pages[p] || '[no text on this page]';
    note = `[Pages ${compactPages(pick)} are scanned images; the text below was transcribed from them by ${r.engine === 'tesseract' ? 'Tesseract' : r.engine}. Use it like any other text. Only if a specific name or number looks garbled, say it may be a transcription slip.]${scanned.length > pick.length ? ` [Only the first ${pick.length} scanned pages were read.]` : ''}\n\n`;
    item.ocr = true;
  }
  bodies.forEach((t, i) => pages.push(`--- Page ${i + 1} ---\n${t}`));
  const text = pages.join('\n\n');
  if (!text.replace(/--- Page \d+ ---/g, '').trim()) throw new Error(CODE_TOKEN ? 'No text found in this PDF' : 'No text found (scanned PDF?). Reading scans works on your own Mac or devices.');
  return note + text;
}

// ---- Reading scans and photos (server: ocr.py — vision model, Tesseract fallback) ----
const OCR_MAX_PAGES = 30;
const compactPages = (ps) => ps.reduce((acc, p, i) => { if (i && p === ps[i - 1] + 1) acc[acc.length - 1][1] = p; else acc.push([p, p]); return acc; }, [])
  .map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
function setFileStatus(item, text) { item.status = text; renderPending(); }

async function ocrFile(file, pages, onProgress) {
  const res = await fetch(`/ocr?name=${encodeURIComponent(file.name)}${pages ? '&pages=' + encodeURIComponent(pages) : ''}`,
    { method: 'POST', headers: { 'X-Code-Token': CODE_TOKEN }, body: file });
  if (res.status === 403) throw new Error('Reading scans needs the page reloaded (the server restarted), or only works on your own Mac or devices');
  if (!res.ok) throw new Error(`Couldn't read the scan (HTTP ${res.status})`);
  const reader = res.body.getReader(), dec = new TextDecoder(), out = {};
  let buf = '', total = 0, done = 0, engine = '';
  onProgress?.(0, 1);
  while (true) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.error) throw new Error(ev.error);
      if (ev.total) total = ev.total;
      if (ev.page != null) { out[ev.page] = ev.text; done++; }
      if (ev.done) engine = ev.engine;
      onProgress?.(done, total || 1);
    }
  }
  return { pages: out, engine };
}

async function extractDocx(file) {
  await loadScript('vendor/mammoth.browser.min.js');
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value;
}

const readAsDataURL = (file) => new Promise((ok, fail) => {
  const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file);
});

async function addFiles(fileList) {
  for (const file of fileList) {
    const item = { id: Math.random().toString(36).slice(2), name: file.name, size: file.size, kind: 'text', loading: true };
    pending.push(item);
    renderPending();
    try {
      const name = file.name.toLowerCase();
      if (file.type.startsWith('image/') || /\.(heic|heif)$/.test(name)) {
        if (file.size > 20 * 1048576) throw new Error('Image is larger than 20 MB');
        const sees = (modelCaps[els.model.value] || []).includes('vision') && !/\.(heic|heif|tiff?)$/.test(name);
        if (sees) {
          item.kind = 'image'; item.mime = file.type;
          item.image = (await readAsDataURL(file)).split(',')[1];
        } else if (CODE_TOKEN) {
          // This chat model can't see images: read the text out of the photo instead
          const r = await ocrFile(file, '', () => setFileStatus(item, 'Reading text from the image…'));
          item.text = `[The text below was transcribed from an image by ${r.engine === 'tesseract' ? 'Tesseract' : r.engine}. Use it like any other text.]\n\n${r.pages[1] || '[no text found in the image]'}`;
          item.ocr = true;
        } else {
          throw new Error(`${els.model.value} can't see images; pick a vision model such as qwen3.8`);
        }
      } else if (name.endsWith('.pdf') || file.type === 'application/pdf') {
        item.text = await extractPdf(file, item);
      } else if (name.endsWith('.docx')) {
        item.text = await extractDocx(file);
      } else if (TEXT_EXT.test(name) || file.type.startsWith('text/') || /json|xml|javascript/.test(file.type) || !name.includes('.')) {
        if (file.size > 20 * 1048576) throw new Error('File is larger than 20 MB');
        item.text = await file.text();
        if (item.text.includes('\u0000')) throw new Error('Looks like a binary file');
      } else {
        throw new Error('Unsupported file type');
      }
      if (item.text && item.text.length > MAX_CHARS) {
        item.text = item.text.slice(0, MAX_CHARS) + '\n\n[… truncated — file too long for the model’s context]';
        toast(`${file.name} was truncated to fit the model’s context`);
      }
      item.loading = false;
    } catch (err) {
      pending = pending.filter((p) => p !== item);
      toast(`${file.name}: ${err.message}`);
    }
    renderPending();
  }
}

function fileChip(f, onRemove) {
  const chip = document.createElement('div');
  chip.className = 'file-chip' + (f.loading ? ' loading' : '');
  const icon = f.kind === 'image' && f.image
    ? `<img src="data:${f.mime || 'image/png'};base64,${f.image}" alt="">`
    : esc(f.loading ? '…' : extOf(f.name));
  const detail = f.loading ? (f.status || 'Reading…') : f.kind === 'image' ? `Image · ${fmtSize(f.size)}` : `${fmtSize(f.size)} · ${f.ocr ? 'read from scan · ' : ''}${(f.text || '').split('\n').length} lines`;
  chip.innerHTML = `<div class="ficon">${icon}</div><div class="fmeta"><div class="fname"></div><div class="fsize">${detail}</div></div>`;
  chip.querySelector('.fname').textContent = f.name;
  chip.title = f.name;
  if (onRemove) {
    const x = document.createElement('button');
    x.className = 'fx'; x.title = 'Remove'; x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.onclick = onRemove;
    chip.appendChild(x);
  }
  return chip;
}

function renderPending() {
  const box = $('#attachments');
  box.innerHTML = '';
  pending.forEach((f) => box.appendChild(fileChip(f, () => { pending = pending.filter((p) => p !== f); renderPending(); })));
  setSendState();
}

// Convert a stored message to what Ollama expects
function toApi(m) {
  if (m.role !== 'user' || !m.files?.length) return { role: m.role, content: m.content };
  const docs = m.files.filter((f) => f.kind === 'text')
    .map((f) => `<file name="${f.name}">\n${f.text}\n</file>`).join('\n\n');
  const images = m.files.filter((f) => f.kind === 'image').map((f) => f.image);
  const content = (docs ? docs + '\n\n' : '') + (m.content || 'Please look at the attached file(s).');
  return images.length ? { role: 'user', content, images } : { role: 'user', content };
}

// Pick a context window big enough for the conversation (tiered so the model isn't reloaded every message)
function contextSize(messages) {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const need = chars / 3 + 4096;
  const max = modelCaps[els.model.value + ':ctx'] || 40960;
  for (const tier of [8192, 16384, 32768]) if (need <= tier) return Math.min(tier, max);
  return max;
}

$('#attach').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
els.input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#drop').classList.add('show'); } });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('show'); } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('show');
  addFiles([...e.dataTransfer.files]);
});
