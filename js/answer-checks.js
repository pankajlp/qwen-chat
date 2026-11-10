// Auto routing, Verify (fact-checking), consistency check, confidence highlights.
// Loaded in order by index.html; all files share one global scope (classic scripts).
// ---------- Auto (Jev autopilot) ----------
// Before each message, four quick calibrated yes/no decisions (2 single-token passes each) choose how to
// answer: search the web? fact-check? think step by step? or is it too unclear, so ask a question first?
const ROUTE_THRESHOLDS = { search: 0.5, verify: 0.5, think: 0.5, clarify: 0.75 };
const ROUTE_QUESTIONS = {
  search: 'Would answering it well need information from the web — current events, prices, recent releases, or specific facts about people, places, products or events that an AI model might not know or might have out of date?',
  verify: 'Will a good answer contain specific factual claims — names, numbers, dates, places, statistics, technical or historical facts — that could be wrong and are worth fact-checking? (Answer No for creative writing, coding help, maths working, brainstorming, opinions, advice or chit-chat.)',
  think: 'Does it need careful step-by-step reasoning to answer correctly — multi-step maths, logic puzzles, tricky code or debugging, or detailed planning — rather than a direct answer?',
  clarify: 'Is it so ambiguous or missing key details that any answer would mostly be a guess, so it is better to ask the user a clarifying question first? (Answer No if a reasonable answer is possible.)',
};

async function autoRoute(msg, history, signal, paint, { allowClarify = true } = {}) {
  const t0 = performance.now();
  msg.status = 'Auto: choosing how to answer…'; paint();
  const system = history[0]?.role === 'system' ? history[0].content + '\n\n' : '';
  // The conversation so far (trimmed, for speed) as context, and the latest message quoted in the question
  const convo = history.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content.length > 1500 ? m.content.slice(0, 1500) + '…' : m.content }));
  const latest = convo.pop()?.content || '';
  const context = convo.slice(-4);
  const cal = jevCalFor(els.model.value);
  const route = {};
  for (const key of Object.keys(ROUTE_QUESTIONS)) {
    if (key === 'clarify' && !allowClarify) { route.clarify = 0; continue; }
    let logp = await scoreOptions({
      question: `Here is the user's latest message${context.length ? ' (the conversation so far is above)' : ''}:\n---\n${latest}\n---\n\n${ROUTE_QUESTIONS[key]}`,
      options: ['Yes', 'No'], system, context, num_ctx: contextSize(history), signal,
    });
    if (cal) logp = logp.map((x) => x / cal.T);
    route[key] = r4(Math.exp(logp[0] - logSumExp(logp)));
  }
  route.ms = Math.round(performance.now() - t0);
  delete msg.status;
  return route;
}

const routeChoices = (r) => ({ web: r.search >= ROUTE_THRESHOLDS.search, verify: r.verify >= ROUTE_THRESHOLDS.verify, think: r.think >= ROUTE_THRESHOLDS.think });

function routeLine(r, m = {}) {
  const c = routeChoices(r), clarify = r.clarify >= ROUTE_THRESHOLDS.clarify;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const parts = clarify ? ['asked a clarifying question first']
    : [c.web && 'searched the web', c.verify && 'fact-checked', m.consistency && `re-asked ${m.consistency.k}×`, c.think && 'thought step by step'].filter(Boolean);
  const title = `Auto decided in ${(r.ms / 1000).toFixed(1)}s — chance each was needed:\nweb search ${pct(r.search)} · fact-check ${pct(r.verify)} · step-by-step thinking ${pct(r.think)} · clarifying question ${pct(r.clarify)}`;
  return `<div class="route" title="${esc(title)}"><span class="chip-on">✦ Auto</span><span class="sep">·</span><span>${parts.length ? parts.join(' · ') : 'answered directly'}</span></div>`;
}

function setAuto(v) {
  settings.auto = !!v; saveSettings();
  $('#auto-btn').setAttribute('aria-pressed', String(settings.auto));
  composerEl.classList.toggle('auto', settings.auto);
  document.body.classList.toggle('auto', settings.auto);
  for (const [sel, what] of [['#web-btn', 'web search'], ['#verify-btn', 'fact-checking']]) {
    $(sel).title = settings.auto ? `Auto is choosing ${what} for each message. Click to switch Auto off and choose yourself.` : $(sel).dataset.title;
  }
  updatePrivacyText();
}
// Using a manual switch while Auto is on hands control back to you
function leaveAuto() {
  if (settings.auto === false) return;
  setAuto(false);
  toast('Auto off — you’re choosing Search, Verify and thinking yourself');
}
$('#auto-btn').onclick = () => { setAuto(!settings.auto); toast(settings.auto ? 'Auto on — Qwen picks search, fact-checking and thinking for each message' : 'Auto off'); };
for (const sel of ['#web-btn', '#verify-btn']) $(sel).dataset.title = $(sel).title;

// ---------- Verify (reduce hallucinations) ----------
// Chain-of-Verification with Jev scoring: after the normal answer (the draft), Qwen lists the checkable
// facts it stated; each one is scored as "Is this true?" *without* showing the draft (so the model can't
// just agree with itself), using the calibrated Jev passes; if any look doubtful, Qwen rewrites the
// answer to drop or flag them, with no new facts allowed. With Search on, the checks see the web pages too.
const VERIFY_MAX_CLAIMS = 8;
const VERIFY_DOUBT = 0.5;  // below this, a claim is rewritten out or flagged
const VERIFY_UNSURE = 0.8; // below this, a claim is shown as uncertain

const CLAIMS_PROMPT = `List the checkable factual claims behind the assistant's answer below: names, numbers, dates, places, events, definitions, technical facts. Each claim must be one short, self-contained statement about the world that is either true or false and makes sense on its own (no "it" or "they"; name the subject).
First, split out every assumption packed into the question itself, even if the answer doesn't repeat it. For example, "What did Einstein say in his speech at the 1952 Tokyo Olympics?" assumes "The 1952 Summer Olympics were held in Tokyo" and "Albert Einstein gave a speech at the 1952 Summer Olympics". Then add the claims the answer makes.
Skip statements about search results, sources, what is or isn't known, or the assistant itself; and skip opinions, advice, instructions, questions, code and trivial statements. At most ${VERIFY_MAX_CLAIMS}. Reply with JSON only.`;
const CLAIMS_SCHEMA = { type: 'object', properties: { claims: { type: 'array', items: { type: 'string' } } }, required: ['claims'] };

// The files the user attached in this conversation (as sent to the model), for fact-checking against
function attachedDocs(convo) {
  return convo.filter((m) => m.role === 'user')
    .map((m) => (String(m.content || '').match(/<file name="[^"]*">[\s\S]*?<\/file>/g) || []).join('\n\n'))
    .filter(Boolean).join('\n\n');
}

async function verifyAnswer(msg, history, signal, paint, { web = settings.web } = {}) {
  const system = history[0]?.role === 'system' ? history[0].content + '\n\n' : '';
  const convo = history.filter((m) => m.role !== 'system');
  const draft = msg.content.trim();

  // 1. Pull out the claims
  msg.verifyStatus = 'Fact-checking: finding the claims…'; paint();
  const extracted = await ollamaChat({
    messages: [{ role: 'system', content: CLAIMS_PROMPT }, { role: 'user', content: `Question: ${convo.at(-1)?.content || ''}\n\nAnswer:\n${draft}` }],
    format: CLAIMS_SCHEMA, options: { temperature: 0, num_ctx: contextSize(history) },
  }, signal);
  let claims = [];
  try { claims = JSON.parse(extracted.message.content).claims || []; } catch {}
  claims = [...new Set(claims.map((c) => String(c).trim()).filter((c) => c.length > 8))].slice(0, VERIFY_MAX_CLAIMS);
  if (!claims.length) { msg.checks = []; return; }

  // 2. Check each claim on its own, without the draft (factored verification), with calibrated Jev scoring.
  // Files the user attached count as evidence: a claim taken from their document is true for this chat
  // (without this, everything read from an attachment looked unverifiable and got stripped out).
  const docs = attachedDocs(convo);
  const sysFor = (claim) => (docs
    ? `${system}Documents the user attached to this conversation. A statement that matches them is true here, even if you couldn't know it otherwise:\n\n${docs.length <= 8000 ? docs : relevantExcerpt(docs, claim, 4000)}\n\n`
    : system);
  const cal = jevCalFor(els.model.value);
  const num_ctx = contextSize(history);
  msg.checks = [];
  for (let i = 0; i < claims.length; i++) {
    msg.verifyStatus = `Fact-checking claim ${i + 1} of ${claims.length}…`; paint();
    const { p, logp } = await scoreClaim(claims[i], sysFor(claims[i]), num_ctx, signal);
    msg.checks.push({ claim: claims[i], p, logp });
  }
  if (cal) msg.calT = +cal.T.toFixed(3);

  // 2b. With Search on, look up the shakiest claims one by one and re-score them with what the web says.
  // The main search is about the question; a search on the claim itself finds what actually confirms or
  // contradicts it (e.g. which city hosted the 1952 Olympics).
  const evidenceFor = new Map();  // claim index -> evidence (kept for the rewrite, not saved)
  if (web) {
    const shaky = msg.checks.map((c, i) => ({ c, i })).filter(({ c }) => c.p < VERIFY_UNSURE)
      .sort((a, b) => a.c.p - b.c.p).slice(0, VERIFY_WEB_CLAIMS);
    if (shaky.length) {
      msg.verifyStatus = `Searching the web for ${shaky.length} uncertain claim${shaky.length === 1 ? '' : 's'}…`; paint();
      const found = await Promise.allSettled(shaky.map(({ c }) => claimEvidence(c.claim, signal)));
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const failed = found.filter((f) => f.status === 'rejected' || !f.value).length;
      if (failed) msg.webCheckNote = `${failed} of ${shaky.length} web check${shaky.length === 1 ? '' : 's'} couldn’t run${found.find((f) => f.status === 'rejected')?.reason?.message ? ` (${found.find((f) => f.status === 'rejected').reason.message})` : ' (no results)'}.`;
      for (let k = 0; k < shaky.length; k++) {
        const ev = found[k].status === 'fulfilled' ? found[k].value : null;
        if (!ev) continue;
        const { c, i } = shaky[k];
        msg.verifyStatus = `Re-checking claim ${k + 1} of ${shaky.length} against the web…`; paint();
        c.pBefore = c.p;
        Object.assign(c, await scoreClaim(c.claim, sysFor(c.claim), num_ctx, signal, ev));
        c.evidence = ev.sources;
        evidenceFor.set(i, ev);
      }
    }
  }

  // 3. Rewrite if anything looks doubtful
  const unstable = msg.consistency && msg.consistency.agree < CONSIST_OK;
  // When re-asking gave different answers, the specific details that changed between them (numbers,
  // names) are disputed: claims that state them count as doubtful, however sure the claim check was
  if (unstable) {
    const disputed = disputedTokens(draft, msg.consistency);
    for (const c of msg.checks) if (sigTokens(c.claim).some((t) => disputed.has(t))) c.disputed = true;
  }
  const doubtful = msg.checks.filter((c) => c.p < VERIFY_DOUBT || c.disputed);
  if (!doubtful.length && !unstable) return;
  msg.verifyStatus = doubtful.length
    ? `Rewriting without ${doubtful.length} doubtful claim${doubtful.length === 1 ? '' : 's'}…`
    : 'Rewriting to reflect that Qwen isn’t sure…';
  msg.draft = draft;
  msg.content = '';
  paint();
  // Write the final answer fresh from the checked facts, without the draft, so it can't anchor on
  // the doubtful details
  const verified = msg.checks.filter((c) => c.p >= VERIFY_DOUBT && !c.disputed).map((c) => `- ${c.claim}`).join('\n') || '- (none)';
  const rejected = doubtful.map((c) => `- ${c.claim}`).join('\n') || '- (none)';
  // If re-asking gave different answers, the rewrite has to say so rather than pick one confidently
  const variants = unstable
    ? `\nWhen the same question was asked ${msg.consistency.k} more times, the answers disagreed:\n${msg.consistency.clusters.map((c) => `- ${c.n} of ${msg.consistency.k}: ${c.rep}`).join('\n')}\n`
    : '';
  // Web evidence gathered for doubtful claims becomes numbered sources the rewrite can cite
  let evidenceNotes = '';
  msg.checks.forEach((c, i) => {
    const ev = evidenceFor.get(i);
    if (!ev || c.p >= VERIFY_DOUBT) return;
    msg.sources = msg.sources || [];
    // Number each page like the main search results ([n] title / url / text) so citations point at the right one
    const numbered = ev.items.map((it) => {
      let s = msg.sources.find((x) => x.url === it.url);
      if (!s) { s = { n: msg.sources.length + 1, title: it.title, url: it.url, read: it.read }; msg.sources.push(s); }
      return `[${s.n}] ${it.title}\n${it.url}\n${it.text}`;
    });
    evidenceNotes += `\nWeb evidence about "${c.claim}":\n\n${numbered.join('\n\n')}\n`;
  });
  const notes = `Fact-check notes for answering the user's latest message (from an independent check of a draft answer):\n\nLikely true:\n${verified}\n\nDoubtful — probably false, made up, or unverifiable:\n${rejected}\n${variants}${evidenceNotes}\n`
    + `Answer the user's latest message now. Do not state any of the doubtful claims as fact. If the question depends on one of them (for example, that a book, person or event exists), say plainly that you can't confirm it rather than describing it. Use the likely-true facts and only general knowledge you are certain of; do not introduce specific names, numbers, dates or details that aren't in the likely-true list`
    + (evidenceNotes ? `, except facts that the web evidence above states explicitly — when a doubtful claim is wrong and the evidence gives the correct fact, give the correct fact and cite it with its source number, like [3]` : '')
    + `.`
    + (unstable ? ` Because the answers disagreed, you don't reliably know the disputed detail: do not give any single specific value for it (unless web evidence above states it explicitly). Say plainly that you're not sure, mention the range or main possibilities you considered, and suggest where the user could check.` : '')
    + ` Don't mention the fact-check itself.`;
  const messages = history.map((m, i) => (i === 0 && m.role === 'system' ? { role: 'system', content: `${m.content}\n\n${notes}` } : m));
  if (messages[0]?.role !== 'system') messages.unshift({ role: 'system', content: notes });
  const res = await fetch('/api/chat', {
    method: 'POST', signal,
    body: JSON.stringify({ model: els.model.value, stream: true, think: false, options: { temperature: 0.2, num_ctx: contextSize(messages) }, messages }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
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
      if (data.message?.content) msg.content += data.message.content;
    }
    paint();
  }
  if (!msg.content.trim()) throw new Error('the revision came back empty');
  msg.revised = true;
}

const VERIFY_WEB_CLAIMS = 3;  // at most this many shaky claims get their own web search per answer
const baseSystem = () => [settings.shareTime !== false && dateTimeContext(), (settings.systemPrompt || '').trim()].filter(Boolean).join('\n\n');

// Calibrated chance that a claim is true, optionally judged against web evidence
async function scoreClaim(claim, system, num_ctx, signal, evidence) {
  const sys = evidence
    ? `${system}Web evidence about the statement you'll be asked about (search results fetched just now):\n\n${evidence.text}\n\nJudge the statement using this evidence together with what you know. If the evidence contradicts the statement, it is false.\n\n`
    : system;
  const raw = await scoreOptions({ question: `Is this statement true? "${claim}"`, options: ['Yes', 'No'], system: sys, num_ctx, signal });
  const cal = jevCalFor(els.model.value);
  const logp = cal ? raw.map((x) => x / cal.T) : raw;
  return { p: Math.exp(logp[0] - logSumExp(logp)), logp: raw.map(r4) };
}

// Keep the lines of a page that share the most words with the claim (pages are long; the claim is one fact)
function relevantExcerpt(text, claim, maxChars = 2500) {
  const words = new Set(claim.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  const lines = text.split('\n').map((line, i) => {
    const lw = line.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    return { line, i, score: lw.filter((w) => words.has(w)).length };
  }).filter((l) => l.score > 0).sort((a, b) => b.score - a.score);
  const picked = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.line.length > maxChars) continue;
    picked.push(l);
    used += l.line.length;
  }
  return picked.sort((a, b) => a.i - b.i).map((l) => l.line).join('\n') || text.slice(0, maxChars);
}

// Search the web for one claim: top 3 results, reading the first page
async function claimEvidence(claim, signal) {
  const query = claim.replace(/[*_"“”`]/g, '').slice(0, 200);
  const { results } = await webGet(`/web/search?q=${encodeURIComponent(query)}`, signal);
  if (!results.length) return null;
  const top = results.slice(0, 3);
  let page = null;
  try { page = await webGet(`/web/fetch?url=${encodeURIComponent(top[0].url)}`, signal); } catch (err) { if (err.name === 'AbortError') throw err; }
  const items = top.map((r, i) => ({
    title: r.title || domainOf(r.url), url: r.url, read: i === 0 && !!page?.text,
    text: i === 0 && page?.text ? relevantExcerpt(page.text, claim) : r.snippet,
  }));
  return {
    items,
    text: items.map((it) => `${it.title}\n${it.url}\n${it.text}`).join('\n\n'),  // for scoring the claim
    sources: items.map(({ title, url, read }) => ({ title, url, read })),
  };
}

// "Check on the web" button on a claim in the fact-check panel
const provingNow = new WeakSet();  // claims being checked right now (kept out of the saved chat)
async function proveClaim(div, i) {
  const m = div._msg, c = m?.checks?.[i];
  if (!c || provingNow.has(c)) return;
  if (controller) return toast('Wait for the reply to finish');
  const wasDoubtful = c.p < VERIFY_DOUBT;
  provingNow.add(c);
  updateAssistant(div, m, false);
  try {
    const ev = await claimEvidence(c.claim);
    if (!ev) toast('The web search found nothing for that claim');
    else {
      const sys = baseSystem();
      if (c.pBefore == null) c.pBefore = c.p;
      Object.assign(c, await scoreClaim(c.claim, sys ? sys + '\n\n' : '', 4096, undefined, ev));
      c.evidence = ev.sources;
      if (c.feedback != null) rateClaim(m, i, c.feedback, true);  // re-record your rating against the new scores
      if ((c.p < VERIFY_DOUBT) !== wasDoubtful) m.checksChanged = true;  // the answer text no longer matches the checks
    }
  } catch (err) {
    toast(`Couldn’t check that claim: ${err.message}`);
  }
  provingNow.delete(c);
  save();
  if (div.isConnected) {
    updateAssistant(div, m, false);
    div.querySelector('.checks')?.setAttribute('open', '');
  }
}
els.messages.addEventListener('click', (e) => {
  const b = e.target.closest('.prove-btn');
  if (b) proveClaim(b.closest('.msg'), +b.dataset.i);
});

// ---------- Consistency check (semantic entropy) ----------
// For questions with a short factual answer: ask again 4 times with more randomness, group the answers
// by meaning (Jev: "do these give the same answer?"), and see how many agree with the one you got.
// If Qwen really knows, the answers agree; if it's guessing, they scatter. An unstable answer gets a
// warning, and Verify's rewrite is told to say it isn't sure instead of stating one guess as fact.
const CONSIST_K = 4;
const CONSIST_OK = 0.5;     // below this share of agreeing re-asks, the answer is flagged as a likely guess
const CONSIST_GOOD = 0.75;  // at or above this, it's shown as consistent
const SHORT_ANSWER_Q = 'Is it asking for a specific fact with a short, definite answer — a name, number, date, place, yes/no, or one definition — that can be stated in a sentence or two? (Answer No for explanations, how-to, advice, opinions, code, creative writing or open-ended discussion.)';

async function consistencyCheck(msg, history, signal, paint) {
  const t0 = performance.now();
  const system = history[0]?.role === 'system' ? history[0].content + '\n\n' : '';
  const convo = history.filter((m) => m.role !== 'system');
  const question = convo.at(-1)?.content || '';
  const num_ctx = contextSize(history);
  const yes = async (q, sys = '', context = []) => {
    const lp = await scoreOptions({ question: q, options: ['Yes', 'No'], system: sys, context, num_ctx, signal });
    return Math.exp(lp[0] - logSumExp(lp));
  };

  // Only worth it when there's one short, definite answer to compare
  msg.verifyStatus = 'Consistency: checking the kind of question…'; paint();
  const shortAnswer = await yes(`Here is the user's latest message:\n---\n${question.slice(0, 1500)}\n---\n\n${SHORT_ANSWER_Q}`, system, convo.slice(0, -1).slice(-4));
  if (shortAnswer < 0.5) return null;

  // Ask again, briefly, with more randomness (and a different seed each time)
  const samples = [];
  for (let k = 0; k < CONSIST_K; k++) {
    msg.verifyStatus = `Consistency: asking again (${k + 1} of ${CONSIST_K})…`; paint();
    const out = await ollamaChat({
      messages: [{ role: 'system', content: system + 'Answer the question directly in one or two sentences.' }, ...convo],
      options: { temperature: 1.0, top_p: 0.95, seed: Math.floor(Math.random() * 1e9), num_predict: 160, num_ctx },
    }, signal);
    const text = (out.message.content || '').trim();
    if (text) samples.push(text);
  }
  if (samples.length < 2) return null;

  // Group the answers by meaning
  const same = (a, b) => yes(`Question: "${question.slice(0, 600)}"\n\nAnswer A: "${a.slice(0, 1200)}"\n\nAnswer B: "${b.slice(0, 1200)}"\n\nDo answers A and B give the same answer to the question? Ignore wording, length and extra details. Answer No only if they state different or contradictory facts (a different name, number, date, place, or yes/no).`);
  msg.verifyStatus = 'Consistency: comparing the answers…'; paint();
  const clusters = [];
  for (const s of samples) {
    let home = null;
    for (const c of clusters) if (await same(s, c.rep) >= 0.5) { home = c; break; }
    if (home) home.members.push(s); else clusters.push({ rep: s, members: [s] });
  }
  // Which group (if any) matches the answer you got
  const draft = msg.content.trim();
  let answerCluster = -1;
  for (let i = 0; i < clusters.length; i++) if (await same(draft, clusters[i].rep) >= 0.5) { answerCluster = i; break; }

  const k = samples.length;
  const agree = answerCluster >= 0 ? clusters[answerCluster].members.length / k : 0;
  const entropy = clusters.reduce((h, c) => { const p = c.members.length / k; return h - p * Math.log2(p); }, 0);
  return {
    k, agree: r4(agree), entropy: r4(entropy), ms: Math.round(performance.now() - t0),
    clusters: clusters.map((c, i) => ({ n: c.members.length, rep: c.rep.slice(0, 400), sameAsAnswer: i === answerCluster }))
      .sort((a, b) => b.sameAsAnswer - a.sameAsAnswer || b.n - a.n),
  };
}

// Details in the answer that re-asking didn't reproduce: numbers the re-asked answers don't all share,
// and names that some of them mention and others don't (a name none of them mention is just extra
// detail, not a contradiction)
function disputedTokens(draft, cs) {
  const reps = cs.clusters.map((c) => new Set(sigTokens(c.rep)));
  const names = new Set((draft.match(/\b\p{Lu}[\p{L}\p{N}]*/gu) || []).map((w) => w.toLowerCase()));
  const out = new Set();
  for (const t of new Set(sigTokens(draft))) {
    const inAll = reps.every((r) => r.has(t)), inSome = reps.some((r) => r.has(t));
    if (/\d/.test(t) ? !inAll : names.has(t) && inSome && !inAll) out.add(t);
  }
  return out;
}

function consistWarning(cs) {
  const n = Math.round(cs.agree * cs.k);
  return `<div class="consist-warn"><span>⚠</span><span><b>Qwen may be guessing.</b> Asked the same question ${cs.k} more times, it gave ${cs.clusters.length} different answer${cs.clusters.length === 1 ? '' : 's'}, and ${n ? `only ${n}` : 'none'} matched this one. See “Consistency” below.</span></div>`;
}

function consistPanel(cs) {
  const n = Math.round(cs.agree * cs.k);
  const tone = cs.agree >= CONSIST_GOOD ? 'ok' : cs.agree >= CONSIST_OK ? 'warn' : 'bad';
  const verdict = tone === 'ok' ? 'consistent' : tone === 'warn' ? 'somewhat consistent' : 'inconsistent — likely a guess';
  const rows = cs.clusters.map((c) => `<div class="variant"><span class="n">${c.n}×</span><span>${esc(c.rep)}${c.sameAsAnswer ? '<span class="tag">same as the answer</span>' : ''}</span></div>`).join('');
  return `<details class="consist"${tone === 'bad' ? ' open' : ''}><summary>${ICONS.retry}<span class="${tone}">●</span><span>Consistency: <b>${n} of ${cs.k}</b> re-asks agreed · ${verdict}</span>${ICONS.chevron}</summary>
    ${rows}<div class="consist-foot">Qwen was asked the same question ${cs.k} more times with extra randomness, and the answers were grouped by meaning. When a model really knows something, its answers agree; when they scatter, it's guessing. Took ${(cs.ms / 1000).toFixed(1)}s.</div></details>`;
}

// ---------- Confidence highlights ----------
// Underline the sentences of the answer that carry an uncertain or doubtful claim (and dotted green for
// claims confirmed on the web). Claims are matched to sentences by their key words and numbers, so it
// needs no extra model call and still works after a rewrite; code is never touched.
const HL_STOP = new Set('the and for are was were with that this from have has had not but its his her their they them than then into onto over also been being which who whom whose what when where why how about after before during while there here your you our can could would should will shall may might must did does doing done per via more most less least very just only such some any each other both either neither been is'.split(' '));
const sigTokens = (text) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => /\d/.test(w) || (w.length >= 3 && !HL_STOP.has(w)));

function splitSentences(text) {
  const out = [];
  let start = 0;
  const push = (a, b) => {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b - a >= 8) out.push({ start: a, end: b, text: text.slice(a, b) });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // A sentence ends at . ! ? followed by a space (so "3.14" and "e.g.x" don't split), or at a line break
    if (ch === '\n' || (/[.!?]/.test(ch) && (i + 1 === text.length || /\s/.test(text[i + 1])))) {
      push(start, ch === '\n' ? i : i + 1);
      start = i + 1;
    }
  }
  push(start, text.length);
  return out;
}

const HL_RANK = { bad: 3, warn: 2, ok: 1 };
function highlightClaims(el, m) {
  if (!el) return;
  const targets = m.checks.map((c, i) => ({
    c, i, level: c.p < VERIFY_DOUBT || c.disputed ? 'bad' : c.p < VERIFY_UNSURE ? 'warn' : c.evidence?.length ? 'ok' : null,
  })).filter((t) => t.level && !(m.revised && t.level === 'bad'));  // doubtful claims a rewrite removed aren't in the text
  if (!targets.length) return;

  // All text outside code, with each text node's offset in the combined string
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('pre, code, a.cite') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n; (n = walker.nextNode());) { nodes.push({ n, start: text.length }); text += n.nodeValue; }
  const sentences = splitSentences(text).map((s) => ({ ...s, tokens: new Set(sigTokens(s.text)), claims: [] }));

  // Each claim goes to the sentence sharing most of its key words (all of its numbers must be there too)
  for (const t of targets) {
    const ct = [...new Set(sigTokens(t.c.claim))];
    if (ct.length < 2) continue;
    const nums = ct.filter((w) => /\d/.test(w));
    let best = null, bestScore = 0;
    for (const s of sentences) {
      const hits = ct.filter((w) => s.tokens.has(w)).length;
      let score = hits / ct.length;
      if (nums.length && !nums.every((w) => s.tokens.has(w))) score *= 0.5;
      if (hits >= 2 && score > bestScore) { best = s; bestScore = score; }
    }
    if (best && bestScore >= 0.5) best.claims.push(t);
  }

  // Wrap the matched sentences, last first so earlier offsets stay valid
  const hit = sentences.filter((s) => s.claims.length).reverse();
  for (const s of hit) {
    const level = s.claims.reduce((a, t) => (HL_RANK[t.level] > HL_RANK[a] ? t.level : a), 'ok');
    for (let k = nodes.length - 1; k >= 0; k--) {
      const { n, start } = nodes[k];
      const a = Math.max(s.start, start), b = Math.min(s.end, start + n.nodeValue.length);
      if (a >= b || !n.parentNode) continue;
      const mid = n.splitText(a - start);
      mid.splitText(b - a);
      const mark = document.createElement('mark');
      mark.className = `hl hl-${level}`;
      mark.dataset.claims = s.claims.map((t) => t.i).join(',');
      mid.replaceWith(mark);
      mark.appendChild(mid);
    }
  }
}

// Hover a highlight: what was checked and how likely it is; click: jump to it in the fact-check panel
const hlPop = $('#hl-pop');
function showHlPop(mark) {
  const m = mark.closest('.msg')?._msg;
  if (!m?.checks) return;
  hlPop.innerHTML = mark.dataset.claims.split(',').map((i) => {
    const c = m.checks[+i];
    if (!c) return '';
    const cls = c.p < VERIFY_DOUBT || c.disputed ? 'bad' : c.p < VERIFY_UNSURE ? 'warn' : 'ok';
    const word = c.disputed ? 'disputed: re-asking gave different answers' : cls === 'bad' ? 'doubtful' : cls === 'warn' ? 'uncertain' : 'confirmed on the web';
    const src = c.evidence?.length ? `<div class="hp-src">Checked against ${c.evidence.map((e) => esc(domainOf(e.url))).join(', ')}${c.pBefore != null ? ` · was ${Math.round(c.pBefore * 100)}% before` : ''}</div>` : '';
    return `<div class="hp-item"><span class="hp-p ${cls}">${Math.round(c.p * 100)}% likely true</span> · ${word}<div>${esc(c.claim)}</div>${src}</div>`;
  }).join('') + '<div class="hp-hint">Click to see it in the fact-check</div>';
  const r = mark.getBoundingClientRect();
  hlPop.classList.add('show');
  const w = hlPop.offsetWidth, h = hlPop.offsetHeight;
  hlPop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  hlPop.style.top = `${r.bottom + 8 + h > innerHeight ? r.top - h - 8 : r.bottom + 8}px`;
}
els.messages.addEventListener('mouseover', (e) => { const mk = e.target.closest('mark.hl'); if (mk) showHlPop(mk); });
els.messages.addEventListener('mouseout', (e) => { if (e.target.closest('mark.hl') && !e.relatedTarget?.closest?.('mark.hl')) hlPop.classList.remove('show'); });
els.scroll.addEventListener('scroll', () => hlPop.classList.remove('show'), { passive: true });
els.messages.addEventListener('click', (e) => {
  const mk = e.target.closest('mark.hl');
  if (!mk) return;
  hlPop.classList.remove('show');
  const panel = mk.closest('.msg').querySelector('.checks');
  if (!panel) return;
  panel.open = true;
  const row = panel.querySelectorAll('.check-row')[+mk.dataset.claims.split(',')[0]];
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('flash');
  void row.offsetWidth;  // restart the animation
  row.classList.add('flash');
});

function checksPanel(m) {
  if (m.verifyError) return `<details class="checks"><summary>${ICONS.shield}<span>Fact-check didn’t finish: ${esc(m.verifyError)}</span></summary></details>`;
  if (!m.checks.length) return `<details class="checks"><summary>${ICONS.shield}<span>Fact-check: no checkable claims in this answer</span></summary></details>`;
  const doubtful = m.checks.filter((c) => c.p < VERIFY_DOUBT || c.disputed).length;
  const unsure = m.checks.filter((c) => c.p >= VERIFY_DOUBT && c.p < VERIFY_UNSURE && !c.disputed).length;
  const tone = doubtful ? 'bad' : unsure ? 'warn' : 'ok';
  const summary = doubtful
    ? `<b>${doubtful} doubtful claim${doubtful === 1 ? '' : 's'}</b> ${m.revised ? 'removed or flagged' : 'found'}`
    : unsure ? `<b>${unsure} uncertain claim${unsure === 1 ? '' : 's'}</b>` : `<b>All ${m.checks.length} claims look right</b>`;
  const rows = m.checks.map((c, i) => {
    const cls = c.p < VERIFY_DOUBT || c.disputed ? 'bad' : c.p < VERIFY_UNSURE ? 'warn' : 'ok';
    const ev = c.disputed ? `<span class="ev">disputed: re-asking gave different answers</span>` : c.evidence?.length
      ? `<span class="ev">${c.pBefore != null ? `was ${Math.round(c.pBefore * 100)}% before checking the web · ` : ''}${c.evidence.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}">${esc(domainOf(s.url))}</a>`).join(', ')}</span>`
      : '';
    const btn = `<button class="prove-btn" data-i="${i}" ${provingNow.has(c) ? 'disabled' : ''} title="Search the web for this claim and re-check it">${provingNow.has(c) ? 'Checking…' : c.evidence?.length ? 'Re-check' : 'Check on the web'}</button>`;
    const fb = c.logp ? `<span class="claim-fb"><button data-claim-fb="1" data-i="${i}" class="${c.feedback === true ? 'on-true' : ''}" title="This claim is true (tunes calibration)">✓</button><button data-claim-fb="0" data-i="${i}" class="${c.feedback === false ? 'on-false' : ''}" title="This claim is false (tunes calibration)">✗</button></span>` : '';
    return `<div class="check-row${(c.p < VERIFY_DOUBT || c.disputed) && m.revised ? ' removed' : ''}"><span class="p ${cls}">${Math.round(c.p * 100)}%</span><span class="c">${esc(c.claim)}${btn}${fb}${ev}</span></div>`;
  }).join('');
  const how = m.calT
    ? 'Each claim was checked separately, without the draft, as a calibrated Jev yes/no question. Percent = chance it’s true.'
    : 'Each claim was checked separately, without the draft, as a Jev yes/no question. Not calibrated yet, so percentages run high — calibrate in ⚙ settings.';
  const draft = m.revised && m.draft ? `<details class="draft"><summary>Show the original draft</summary><div class="content">${renderMarkdown(m.draft)}</div></details>` : '';
  return `<details class="checks"${doubtful ? ' open' : ''}><summary>${ICONS.shield}<span class="${tone}">●</span><span>Fact-checked ${m.checks.length} claim${m.checks.length === 1 ? '' : 's'} · ${summary}</span>${ICONS.chevron}</summary>
    <div class="check-list">${rows}</div>${m.checksChanged ? '<div class="check-stale">A web check changed a claim’s verdict after this answer was written — regenerate for an answer that reflects it.</div>' : ''}<div class="check-foot">${how}${m.webCheckNote ? ' ' + esc(m.webCheckNote) : ''} In the answer, <span class="bad">red</span> underlines are doubtful, <span class="warn">amber</span> uncertain, and <span class="ok">green dotted</span> confirmed on the web — hover or click them.</div>${draft}</details>`;
}

function setVerify(v) {
  settings.verify = !!v; saveSettings();
  $('#verify-btn').setAttribute('aria-pressed', String(settings.verify));
}
$('#verify-btn').onclick = () => { leaveAuto(); setVerify(!settings.verify); };
