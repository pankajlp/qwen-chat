// Web search before answering.
// Loaded in order by index.html; all files share one global scope (classic scripts).
// ---------- Web search ----------
// When the Search toggle is on: Qwen decides whether the question needs the web and writes queries,
// the local server searches DuckDuckGo and reads the top pages, and Qwen answers citing [1], [2]…
const WEB_READ_PAGES = 3;
const WEB_MAX_SOURCES = 6;

const WEB_QUERY_PROMPT = `Decide whether answering the user's latest message needs information from the web: current events, prices, recent releases, specific facts, people, places, products, or anything you might not know or might be out of date on.
Reply with JSON only. If it does, set search to true and write 1 or 2 short search-engine queries (keywords, include the year for recent things). If it's chit-chat, creative writing, maths, coding help or general knowledge you're sure of, set search to false and queries to [].`;

const WEB_SCHEMA = {
  type: 'object',
  properties: { search: { type: 'boolean' }, queries: { type: 'array', items: { type: 'string' } } },
  required: ['search', 'queries'],
};

async function webGet(path, signal) {
  const res = await fetch(path, { signal });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// Returns the text to add to the system prompt, or null if no search was needed / possible
async function webContext(msg, history, signal, paint, decided = false) {
  const system = history[0]?.role === 'system' ? history[0].content + '\n\n' : '';
  const convo = history.filter((m) => m.role !== 'system');

  msg.status = decided ? 'Writing search queries…' : 'Deciding whether to search…'; paint();
  let plan;
  try {
    const prompt = decided  // Auto already decided a search is needed
      ? 'Write 1 or 2 short search-engine queries (keywords, include the year for recent things) to find what is needed to answer the user\'s latest message. Reply with JSON only, with search set to true.'
      : WEB_QUERY_PROMPT;
    const out = await ollamaChat({ messages: [{ role: 'system', content: system + prompt }, ...convo], format: WEB_SCHEMA, options: { temperature: 0, num_ctx: contextSize(history) } }, signal);
    plan = JSON.parse(out.message.content);
    if (decided) plan.search = true;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    plan = { search: true, queries: [String(convo.at(-1)?.content || '').slice(0, 200)] };
  }
  const queries = [...new Set((plan.queries || []).map((q) => String(q).trim()).filter(Boolean))].slice(0, 2);
  if (!plan.search || !queries.length) { msg.webNote = 'Answered without searching the web'; return null; }

  msg.status = `Searching the web for “${queries.join('” and “')}”…`; paint();
  const found = [];
  const lists = await Promise.allSettled(queries.map((q) => webGet(`/web/search?q=${encodeURIComponent(q)}`, signal)));
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  lists.forEach((l) => { if (l.status === 'fulfilled') for (const r of l.value.results) if (!found.some((f) => f.url === r.url)) found.push(r); });
  if (!found.length) {
    const why = lists.find((l) => l.status === 'rejected')?.reason?.message;
    msg.webNote = why ? `Web search failed (${why}) — answered from Qwen’s own knowledge` : 'The web search found nothing — answered from Qwen’s own knowledge';
    return null;
  }
  const results = found.slice(0, WEB_MAX_SOURCES);

  msg.status = `Reading ${Math.min(WEB_READ_PAGES, results.length)} pages…`; paint();
  const pages = await Promise.allSettled(results.slice(0, WEB_READ_PAGES).map((r) => webGet(`/web/fetch?url=${encodeURIComponent(r.url)}`, signal)));
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  msg.sources = results.map((r, i) => {
    const page = pages[i]?.status === 'fulfilled' && pages[i].value.text.length > 200 ? pages[i].value : null;
    return { n: i + 1, title: r.title || page?.title || domainOf(r.url), url: r.url, read: !!page, text: page ? page.text : r.snippet };
  });
  const read = msg.sources.filter((s) => s.read).length;
  msg.webNote = `Searched the web for “${queries.join('”, “')}” · read ${read} page${read === 1 ? '' : 's'}`;
  const context = `Web search results, retrieved just now for the user's latest message. Use them to answer, and cite the sources you use inline with their numbers, like [1] or [2][3]. Prefer these results over your own memory for anything recent or specific. If they don't contain the answer, say so and answer as best you can.\n\n`
    + msg.sources.map((s) => `[${s.n}] ${s.title}\n${s.url}\n${s.text}`).join('\n\n');
  msg.sources.forEach((s) => delete s.text);  // don't store page text in the chat
  return context;
}

// Turn [1] / [2] in a rendered answer into small links to the sources (never inside code)
function linkCitations(htmlText, sources) {
  if (!sources?.length) return htmlText;
  return htmlText.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/).map((part, i) => (i % 2 ? part
    : part.replace(/\[(\d{1,2})\]/g, (m, n) => {
      const s = sources.find((x) => x.n === +n);
      return s ? `<a class="cite" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}">${n}</a>` : m;
    }))).join('');
}

function sourcesList(sources) {
  return `<div class="sources"><div class="src-label">Sources</div><div class="src-list">${sources.map((s) =>
    `<a class="src${s.read ? '' : ' snippet-only'}" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}${s.read ? '' : ' (search snippet only)'}"><span class="n">${s.n}</span><span class="t">${esc(s.title)}</span><span class="d">${esc(domainOf(s.url))}</span></a>`).join('')}</div></div>`;
}

function setWeb(v) {
  settings.web = !!v; saveSettings();
  $('#web-btn').setAttribute('aria-pressed', String(settings.web));
  updatePrivacyText();
}

function updatePrivacyText() {
  const auto = settings.auto !== false, web = auto || settings.web;
  $('#disclaimer').textContent = auto
    ? 'Auto mode: for each message Qwen decides whether to search the web (via DuckDuckGo), fact-check or think step by step. Qwen can make mistakes.'
    : web ? 'Web search is on: when a question needs it, search terms go to DuckDuckGo and pages are fetched from their sites. Qwen can make mistakes.'
      : 'Qwen can make mistakes. Please double-check responses.';
  $('#privacy-line').textContent = web
    ? `Qwen runs on your machine. ${auto ? 'Auto mode' : 'Web search'} is on, so questions that need the web are looked up on DuckDuckGo.`
    : 'Running locally on your machine — nothing leaves your computer.';
}
$('#web-btn').onclick = () => { leaveAuto(); setWeb(!settings.web); };
