// Jev mode: typed decisions with calibrated probabilities, calibration, your ratings.
// Loaded in order by index.html; all files share one global scope (classic scripts).
// ---------- Jev mode ----------
// A local take on TypeSafe's Jev ("System One" model): instead of writing prose, the answer is a typed
// decision with a probability for every option. Following Nokia's open-source AnyJev method:
//   1. Qwen frames the question as yes/no, a choice between options, or an ordered score.
//   2. Qwen answers with a single letter; the probability of each option's letter is read from logprobs.
//   3. That's repeated with the options rotated (A-B-C, B-C-A, …) and averaged, cancelling position bias.
//   4. For yes/no, Qwen's running lean toward "yes" or "no" is divided out once 8 questions have been seen.
// These are Qwen's own probabilities with those corrections, not trained on real outcomes like Jev's.
const JEV_DONE = Symbol('jev done');
const JEV_MAX_OPTIONS = 8;
const LETTERS = 'ABCDEFGH';

const JEV_FRAME_PROMPT = `You turn the user's latest message into a decision question for a decision engine.
Reply with JSON only.
- kind "yesno": a yes/no question with a factual or clear-cut answer. options must be exactly ["Yes", "No"].
- If the message asks whether something uncertain, random or in the future will happen (coin flips, dice, weather, markets, sports results, "will…"), use kind "score" with a likelihood scale instead of "yesno".
- kind "choice": pick one of several answers. options: 2 to 8 short, distinct answers covering the realistic possibilities (use the user's own options if they gave some). Questions asking for a count, number, date or amount are "choice" too, with nearby candidate values as options (e.g. ["1", "2", "3", "4"]).
- kind "score": a rating, likelihood or amount. options: an ordered scale from lowest to highest (usually 5 steps), e.g. ["Very unlikely", "Unlikely", "Even odds", "Likely", "Very likely"].
- kind "open": only if the message can't be answered by picking from a list (e.g. "write…", "explain…", "summarize…", greetings). Then options is [].
question: the question, rewritten to stand on its own (resolve "it", "that", etc. from the conversation).`;

const JEV_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['yesno', 'choice', 'score', 'open'] },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
  },
  required: ['kind', 'question', 'options'],
};

async function ollamaChat(body, signal) {
  const res = await fetch('/api/chat', { method: 'POST', signal, body: JSON.stringify({ model: els.model.value, stream: false, think: false, ...body }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

const logSumExp = (xs) => { const m = Math.max(...xs); return m + Math.log(xs.reduce((s, x) => s + Math.exp(x - m), 0)); };

// Returns true if it answered; false if the question isn't a decision (then a normal reply follows)
async function runJev(msg, history, signal, paint) {
  const t0 = performance.now();
  const system = history[0]?.role === 'system' ? history[0].content + '\n\n' : '';
  const convo = history.filter((m) => m.role !== 'system');
  const num_ctx = contextSize(history);

  // 1. Frame the question as a typed decision
  msg.status = 'Framing the question…'; paint();
  const framed = await ollamaChat({
    messages: [{ role: 'system', content: system + JEV_FRAME_PROMPT }, ...convo],
    format: JEV_SCHEMA, options: { temperature: 0, num_ctx },
  }, signal);
  let frame;
  try { frame = JSON.parse(framed.message.content); } catch { frame = { kind: 'open' }; }
  const options = [...new Set((frame.options || []).map((o) => String(o).trim()).filter(Boolean))].slice(0, JEV_MAX_OPTIONS);
  if (frame.kind === 'yesno') options.splice(0, options.length, 'Yes', 'No');
  if (frame.kind === 'open' || options.length < 2) {
    msg.jevNote = 'Not a decision question — answered normally.';
    delete msg.status;
    return false;
  }
  const K = options.length;
  const question = String(frame.question || '').trim() || convo.at(-1)?.content || '';

  // 2–3. One single-token pass per rotation of the options
  const rawLogp = await scoreOptions({
    question, options, system, context: convo.slice(0, -1), num_ctx, signal,
    onPass: (r) => { msg.status = `Scoring ${K} options · pass ${r + 1} of ${K}…`; paint(); },
  });
  let logp = rawLogp;
  // Temperature from this model's calibration run, if any (keeps the ranking, fixes over/under-confidence)
  const cal = jevCalFor(els.model.value);
  if (cal) logp = logp.map((x) => x / cal.T);

  // 4. Yes/no: divide out Qwen's running prior (AnyJev batch calibration, strength 0.75 after 8 items)
  let calibrated = false;
  if (frame.kind === 'yesno') {
    const raw = logp.map((x) => x - logSumExp(logp));
    const prior = settings.jevPrior || { n: 0, yes: 0.5 };
    if (prior.n >= 8) {
      const pr = [Math.log(prior.yes), Math.log(1 - prior.yes)];
      logp = logp.map((x, i) => x - 0.75 * pr[i]);
      calibrated = true;
    }
    prior.yes = (prior.yes * prior.n + Math.exp(raw[0])) / (prior.n + 1);
    prior.yes = Math.min(0.99, Math.max(0.01, prior.yes));
    prior.n++;
    settings.jevPrior = prior;
    saveSettings();
  }
  const Z = logSumExp(logp);
  const probs = logp.map((x) => Math.exp(x - Z));

  const best = probs.indexOf(Math.max(...probs));
  const j = { kind: frame.kind, question, options, probs, decision: best, passes: K + 1, ms: Math.round(performance.now() - t0), calibrated };
  j.logp = rawLogp.map(r4);  // raw scores, kept so a 👍/👎 on this card can feed calibration
  if (cal) { j.calT = +cal.T.toFixed(3); j.calN = cal.n; j.calUser = cal.userN || 0; }
  if (frame.kind === 'score') j.expected = probs.reduce((s, p, i) => s + p * (i + 1), 0);
  msg.jev = j;
  delete msg.status;
  msg.content = jevSummary(j);  // plain-text version for history, search and export
  return true;
}

// One single-token pass per rotation of the options (A-B-C, B-C-A, …); returns each option's average
// log-probability (a geometric mean across rotations, which cancels position bias)
const DECIDE_PROMPT = 'You are a decision engine. Answer with only the letter of the single best option.';
async function scoreOptions({ question, options, system = '', context = [], num_ctx = 4096, signal, onPass }) {
  const K = options.length;
  const sums = new Array(K).fill(0);
  for (let r = 0; r < K; r++) {
    onPass?.(r);
    const order = options.map((_, i) => (i + r) % K);  // position -> original option index
    const listing = order.map((oi, pos) => `${LETTERS[pos]}) ${options[oi]}`).join('\n');
    const out = await ollamaChat({
      messages: [
        { role: 'system', content: system + DECIDE_PROMPT },
        ...context,
        { role: 'user', content: `Question: ${question}\n\nOptions:\n${listing}\n\nAnswer with one letter.` },
      ],
      logprobs: true, top_logprobs: 20, options: { temperature: 0, num_predict: 1, num_ctx },
    }, signal);
    const top = out.logprobs?.[0]?.top_logprobs || [];
    if (!top.length) throw new Error('This Ollama version doesn’t return token probabilities (needs logprobs support)');
    const floor = Math.min(...top.map((t) => t.logprob)) - 1;  // letters outside the top 20 get less than the least likely seen
    const lp = order.map((_, pos) => {
      const hit = top.find((t) => t.token.trim().toUpperCase() === LETTERS[pos]);
      return hit ? hit.logprob : floor;
    });
    const norm = logSumExp(lp);
    order.forEach((oi, pos) => { sums[oi] += lp[pos] - norm; });
  }
  return sums.map((x) => x / K);
}

// ----- Calibration (AnyJev "L1": temperature scaling fitted on questions with known answers) -----
const jevCalFor = (model) => settings.jevCal?.[model] || null;
const softmaxT = (logp, T) => { const z = logp.map((x) => x / T), Z = logSumExp(z); return z.map((x) => Math.exp(x - Z)); };

// Average negative log-likelihood of the right answers at temperature T (lower is better)
const nllAt = (items, T) => {
  let sum = 0, weight = 0;
  for (const it of items) {
    const w = it.w ?? 1;  // your own ratings count more than the built-in questions
    sum -= w * Math.log(Math.max(1e-12, softmaxT(it.logp, T)[it.correct]));
    weight += w;
  }
  return sum / weight;
};
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const argmax = (a) => a.indexOf(Math.max(...a));

// Expected calibration error: how far stated confidence is from actual accuracy, averaged over 10 bins
function eceAt(items, T) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, right: 0 }));
  for (const it of items) {
    const p = softmaxT(it.logp, T), c = Math.max(...p);
    const b = bins[Math.min(9, Math.floor(c * 10))];
    b.n++; b.conf += c; b.right += p.indexOf(c) === it.correct ? 1 : 0;
  }
  return bins.reduce((s, b) => s + (b.n ? (b.n / items.length) * Math.abs(b.conf / b.n - b.right / b.n) : 0), 0);
}

// Golden-section search for the temperature that minimises NLL (searched on log T between 0.25 and 50)
function fitTemperature(items) {
  let a = Math.log(0.25), b = Math.log(50);
  const g = (Math.sqrt(5) - 1) / 2, f = (u) => nllAt(items, Math.exp(u));
  let c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  for (let i = 0; i < 60; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return Math.exp((a + b) / 2);
}

let calRun = null;  // AbortController while calibrating

async function runCalibration() {
  const set = window.JEV_CALIBRATION_SET || [];
  if (!set.length) return toast('Calibration questions didn’t load (jev-calibration.js)');
  const model = els.model.value;
  calRun = new AbortController();
  renderCalStatus();
  const items = [];
  try {
    for (let i = 0; i < set.length; i++) {
      const [question, options, correct] = set[i];
      showCalProgress(i, set.length);
      const logp = await scoreOptions({ question, options, num_ctx: 2048, signal: calRun.signal });
      items.push({ logp, correct });
    }
  } catch (err) {
    calRun = null;
    showCalProgress(null);
    renderCalStatus();
    if (err.name !== 'AbortError') toast(`Calibration failed: ${err.message}`);
    return;
  }
  // Report on questions held out from fitting (3-fold cross-validation), then fit on everything
  const held = items.map((it, i) => ({ ...it, fold: i % 3 }));
  let heldNll = 0, heldEceItems = [];
  for (let f = 0; f < 3; f++) {
    const T = fitTemperature(held.filter((it) => it.fold !== f));
    const test = held.filter((it) => it.fold === f);
    heldNll += nllAt(test, T) * test.length;
    heldEceItems.push(...test.map((it) => ({ logp: it.logp.map((x) => x / T), correct: it.correct })));
  }
  const T = fitTemperature(items);
  const right = items.filter((it) => { const p = softmaxT(it.logp, 1); return p.indexOf(Math.max(...p)) === it.correct; }).length;
  const avgConf = (t) => items.reduce((s, it) => s + Math.max(...softmaxT(it.logp, t)), 0) / items.length;
  settings.jevCal = {
    ...settings.jevCal,
    [model]: {
      T, n: items.length, accuracy: right / items.length,
      eceBefore: eceAt(items, 1), eceAfter: eceAt(heldEceItems, 1),
      nllBefore: nllAt(items, 1), nllAfter: heldNll / items.length,
      confBefore: avgConf(1), confAfter: avgConf(T), date: Date.now(), baseT: T,
      items: items.map((it) => ({ logp: it.logp.map(r4), correct: it.correct })),  // kept to combine with your ratings
    },
  };
  refitCalibration(model);  // include any ratings you've already given
  delete settings.jevPrior;  // the yes/no lean is re-learned on the new probability scale
  saveSettings();
  calRun = null;
  showCalProgress(null);
  renderCalStatus();
  toast(`Jev mode calibrated for ${model}`);
}

function showCalProgress(i, n) {
  $('#cal-progress').hidden = i == null;
  if (i == null) return;
  $('#cal-bar').style.width = `${(i / n) * 100}%`;
  $('#cal-progress-text').textContent = `Question ${i + 1} of ${n}`;
}

function renderCalStatus() {
  const model = els.model.value, cal = jevCalFor(model), pct = (x) => `${Math.round(x * 100)}%`;
  const status = $('#cal-status');
  if (calRun) {
    status.innerHTML = `Asking <b>${esc(model)}</b> ${(window.JEV_CALIBRATION_SET || []).length} questions with known answers, using the same passes Jev mode uses. This takes a few minutes; you can close this window.`;
  } else if (cal) {
    const fb = feedbackFor(model), usable = fb.filter((f) => Number.isInteger(f.correct));
    const mine = usable.length
      ? ` <b>Plus ${usable.length} of your ratings</b> (Qwen was right on ${usable.filter((f) => argmax(f.logp) === f.correct).length} of them), which count double — temperature now <b>${cal.T.toFixed(2)}</b>${cal.baseT ? ` (${cal.baseT.toFixed(2)} from the built-in questions alone)` : ''}.`
      : ' Rate decision cards (👍/👎) and fact-checked claims (✓/✗) to tune it to your own questions.';
    status.innerHTML = cal.n
      ? `<b>Calibrated for ${esc(model)}</b> on ${fmtDate(cal.date).slice(0, 10)}. On ${cal.n} known-answer questions Qwen was right <b>${pct(cal.accuracy)}</b> of the time but claimed ${pct(cal.confBefore)} average certainty. `
        + `After calibration its average confidence is ${pct(cal.confAfter)}, and on held-out questions the calibration error dropped from <b>${pct(cal.eceBefore)}</b> to <b>${pct(cal.eceAfter)}</b>${cal.items ? '.' : ` (temperature ${cal.T.toFixed(2)}).`}`
        + (cal.items ? mine : ' <b>Recalibrate once</b> so your ratings can be combined with it.')
      : `<b>Calibrated for ${esc(model)} from your ratings only</b>: ${usable.length} ratings, temperature ${cal.T.toFixed(2)}. Run Calibrate to add the ${(window.JEV_CALIBRATION_SET || []).length} built-in questions.`;
  } else {
    status.innerHTML = `<b>${esc(model)}</b> isn't calibrated yet, so Jev mode shows Qwen's raw certainty, which is usually overconfident. Calibrating asks it ${(window.JEV_CALIBRATION_SET || []).length} questions with known answers (a few minutes) and rescales its probabilities to match how often it's actually right.`;
  }
  $('#cal-run').textContent = calRun ? 'Cancel' : cal ? 'Recalibrate' : 'Calibrate';
  $('#cal-reset').hidden = !cal || !!calRun;
}

$('#cal-run').onclick = () => (calRun ? calRun.abort() : runCalibration());
$('#cal-reset').onclick = () => {
  if (!confirm('Reset Jev mode calibration for this model, including your ratings?')) return;
  if (settings.jevCal) delete settings.jevCal[els.model.value];
  if (settings.jevFeedback) delete settings.jevFeedback[els.model.value];
  delete settings.jevPrior;
  saveSettings();
  renderCalStatus();
  toast('Jev mode calibration and ratings reset');
};

// ----- Your ratings as calibration data -----
// A 👍/👎 on a decision card or a ✓/✗ on a fact-checked claim is a known right answer for the scores
// Qwen gave. They're kept per model, combined with the built-in questions (counting double), and the
// temperature is refitted straight away, so later answers are calibrated to the kinds of things you ask.
const USER_WEIGHT = 2;
const MIN_RATINGS_ALONE = 5;  // without a calibration run, wait for this many ratings before fitting
const feedbackFor = (model) => settings.jevFeedback?.[model] || [];

function recordFeedback(model, id, logp, correct) {  // correct: option index, 'none', or null to remove
  const all = (settings.jevFeedback ||= {});
  const list = (all[model] ||= []);
  const i = list.findIndex((f) => f.id === id);
  if (correct == null) { if (i >= 0) list.splice(i, 1); }
  else {
    const entry = { id, logp: logp.map(r4), correct, time: Date.now() };
    if (i >= 0) list[i] = entry; else list.push(entry);
    if (list.length > 500) list.splice(0, list.length - 500);
  }
  const before = jevCalFor(model)?.T;
  refitCalibration(model);
  saveSettings();
  return { before, after: jevCalFor(model)?.T };
}

function refitCalibration(model) {
  const cal = jevCalFor(model);
  if (cal && !cal.items && cal.n) return;  // an older calibration without saved questions: needs a recalibration first
  const usable = feedbackFor(model).filter((f) => Number.isInteger(f.correct));
  const base = cal?.items || [];
  if (!base.length && usable.length < MIN_RATINGS_ALONE) return;
  const items = [...base, ...usable.map((f) => ({ logp: f.logp, correct: f.correct, w: USER_WEIGHT }))];
  const T = items.length ? fitTemperature(items) : cal.baseT;
  settings.jevCal = { ...settings.jevCal, [model]: { ...(cal || { n: 0, date: Date.now() }), T, userN: usable.length } };
}

function calibrationToast({ before, after }) {
  if (after == null) return toast('Thanks — saved. Your ratings start tuning calibration once there are a few more, or after a calibration run.');
  if (before == null) return toast(`Thanks — Jev mode is now calibrated from your ratings (temperature ${after.toFixed(2)})`);
  toast(Math.abs(after - before) < 0.005 ? 'Thanks — rating saved' : `Thanks — calibration updated (temperature ${before.toFixed(2)} → ${after.toFixed(2)})`);
}

// Decision card: 👍 = the decision was right; 👎 = pick the option that was right (or "none of these")
const pickingNow = new WeakSet();
function rateDecision(div, correct) {
  const m = div._msg, j = m?.jev;
  if (!j?.logp || !m.time) return;
  const change = recordFeedback(m.model || els.model.value, `${m.time}:d`, j.logp, correct);
  if (correct == null) delete j.feedback; else j.feedback = correct;
  pickingNow.delete(j);
  save();
  updateAssistant(div, m, false);
  if (correct != null && correct !== 'none') calibrationToast(change);
  else if (correct === 'none') toast('Thanks — noted. Only ratings with a right option among the choices can tune calibration.');
}

// Fact-check claim: ✓ = true, ✗ = false (clicking the same one again removes the rating)
function rateClaim(m, i, value, quiet) {
  const c = m.checks?.[i];
  if (!c?.logp || !m.time) return;
  const next = !quiet && c.feedback === value ? null : value;
  const change = recordFeedback(m.model || els.model.value, `${m.time}:c${i}`, c.logp, next == null ? null : next ? 0 : 1);
  if (next == null) delete c.feedback; else c.feedback = next;
  save();
  if (!quiet && next != null) calibrationToast(change);
}

els.messages.addEventListener('click', (e) => {
  const div = e.target.closest('.msg');
  if (!div?._msg) return;
  const t = e.target.closest('[data-fb]');
  if (t) {
    const j = div._msg.jev;
    if (t.dataset.fb === 'yes') rateDecision(div, j.decision);
    else if (t.dataset.fb === 'no') { pickingNow.add(j); updateAssistant(div, div._msg, false); }
    else if (t.dataset.fb === 'none') rateDecision(div, 'none');
    else if (t.dataset.fb === 'cancel') { pickingNow.delete(j); updateAssistant(div, div._msg, false); }
    else if (t.dataset.fb === 'undo') rateDecision(div, null);
    return;
  }
  const opt = e.target.closest('.jev.picking [data-opt]');
  if (opt) return rateDecision(div, +opt.dataset.opt);
  const cb = e.target.closest('[data-claim-fb]');
  if (cb) {
    rateClaim(div._msg, +cb.dataset.i, cb.dataset.claimFb === '1');
    updateAssistant(div, div._msg, false);
    div.querySelector('.checks')?.setAttribute('open', '');
  }
});

function jevFeedbackRow(j) {
  if (!j.logp) return '';
  if (pickingNow.has(j)) {
    return `<div class="jev-fb">Click the option that was actually right, or <button class="fb-btn" data-fb="none">None of these</button> <button class="fb-undo" data-fb="cancel">cancel</button></div>`;
  }
  if (j.feedback == null) {
    return `<div class="jev-fb">Was this right? <button class="fb-btn" data-fb="yes" title="Yes — the decision was right">👍</button><button class="fb-btn" data-fb="no" title="No — pick the right option">👎</button> <span>Your ratings tune calibration.</span></div>`;
  }
  const said = j.feedback === 'none' ? 'You said none of these was right.'
    : j.feedback === j.decision ? 'You marked this right.' : `You said the right answer was “${esc(j.options[j.feedback])}”.`;
  return `<div class="jev-fb"><span class="fb-done">${said}</span> <button class="fb-undo" data-fb="undo">undo</button></div>`;
}

const pctText = (p) => (p >= 0.9995 ? '>99.9%' : p < 0.0005 ? '<0.1%' : `${(p * 100).toFixed(1)}%`);
const confLabel = (p) => (p >= 0.9 ? 'high' : p >= 0.7 ? 'medium' : 'low');
const confWord = (j) => (j.calT ? 'confidence' : 'certainty');  // "certainty" = Qwen's raw lean, not calibrated
const kindLabel = (j) => (j.kind === 'yesno' ? 'yes / no' : j.kind === 'score' ? `score · ${j.options.length} steps` : `choice · ${j.options.length} options`);

function jevSummary(j) {
  const p = j.probs[j.decision];
  let md = `**Decision:** ${j.options[j.decision]} — ${pctText(p)} (${confLabel(p)} ${confWord(j)})\n\n*${j.question}*\n\n| Option | Probability |\n|---|---|\n`;
  md += j.options.map((o, i) => `| ${o.replace(/\|/g, '\\|')} | ${pctText(j.probs[i])} |`).join('\n');
  if (j.expected) md += `\n\nExpected score: ${j.expected.toFixed(2)} of ${j.options.length}`;
  return md;
}

function jevCard(j) {
  const p = j.probs[j.decision];
  const rows = j.options.map((o, i) => {
    const top = i === j.decision ? ' top' : '';
    return `<span class="opt${top}" data-opt="${i}" title="${esc(o)}">${esc(o)}</span><span class="jev-bar${top}"><i style="width:${(j.probs[i] * 100).toFixed(2)}%"></i></span><span class="pct">${pctText(j.probs[i])}</span>`;
  }).join('');
  const expected = j.expected ? ` · expected ${j.expected.toFixed(2)} of ${j.options.length}` : '';
  return `<div class="jev${pickingNow.has(j) ? ' picking' : ''}">
    <div class="jev-q"><span class="jev-type">${kindLabel(j)}</span><b>${esc(j.question)}</b></div>
    <div class="jev-decision"><strong>${esc(j.options[j.decision])}</strong><span class="jev-conf"><b>${pctText(p)}</b> · ${confLabel(p)} ${confWord(j)}${expected}</span></div>
    <div class="jev-rows">${rows}</div>
    ${jevFeedbackRow(j)}
    ${j.calT
      ? `<div class="jev-foot" title="Probabilities are rescaled (temperature ${j.calT}) so that, on ${j.calN} questions with known answers, stated confidence matched how often Qwen was right. Position bias is removed${j.calibrated ? ' and Qwen’s yes/no lean divided out' : ''}. The calibration questions are factual, so opinions and predictions may still be off.">Jev mode · ${j.passes - 1} single-token passes · calibrated on ${j.calN ? `${j.calN} known-answer questions` : ''}${j.calN && j.calUser ? ' + ' : ''}${j.calUser ? `${j.calUser} of your ratings` : ''} ⓘ</div>`
      : `<div class="jev-foot" title="Probabilities are Qwen's own, with position bias removed${j.calibrated ? ' and its yes/no lean divided out' : ''}. They aren't calibrated yet, so Qwen tends to be overconfident — run Calibrate in ⚙ settings.">Jev mode · ${j.passes - 1} single-token passes · Qwen's certainty, not calibrated ⓘ</div>`}
  </div>`;
}

// For import: rebuild a Jev result from untrusted JSON (or drop it)
function cleanJev(j) {
  if (!j || typeof j !== 'object' || !['yesno', 'choice', 'score'].includes(j.kind)) return null;
  const options = Array.isArray(j.options) ? j.options.slice(0, JEV_MAX_OPTIONS).map((o) => str(o, 200)) : [];
  const probs = Array.isArray(j.probs) ? j.probs.slice(0, options.length).map((p) => Math.min(1, Math.max(0, num(p) || 0))) : [];
  if (options.length < 2 || probs.length !== options.length) return null;
  const decision = Number.isInteger(j.decision) && j.decision >= 0 && j.decision < options.length ? j.decision : probs.indexOf(Math.max(...probs));
  const out = { kind: j.kind, question: str(j.question, 1000), options, probs, decision, passes: Math.round(num(j.passes) || options.length + 1), ms: Math.round(num(j.ms) || 0), calibrated: !!j.calibrated };
  if (j.kind === 'score' && num(j.expected) !== undefined) out.expected = num(j.expected);
  if (num(j.calT) > 0) { out.calT = num(j.calT); out.calN = Math.round(num(j.calN) || 0); out.calUser = Math.round(num(j.calUser) || 0); }
  if (Array.isArray(j.logp) && j.logp.length === options.length && j.logp.every((x) => Number.isFinite(x))) out.logp = j.logp.map(r4);
  if ((Number.isInteger(j.feedback) && j.feedback >= 0 && j.feedback < options.length) || j.feedback === 'none') out.feedback = j.feedback;
  return out;
}

const autoTitle = (text) => text.slice(0, 50) + (text.length > 50 ? '…' : '');
