// Voice input: recording, live previews, transcription (on the Mac's GPU, or Whisper in the browser).
// Loaded in order by index.html; all files share one global scope (classic scripts).
// ---------- Voice input (on-device Whisper) ----------
// While you talk, a quick model re-transcribes what you've said every couple of seconds and the text
// appears (greyed) in the message box. When you press Stop, the chosen model makes one clean pass over
// the whole recording and replaces that preview (Fast mode reuses an up-to-date preview instead).
const MAX_REC_SECS = 300;
const VOICE_START_TIMEOUT = 20000;  // ms to wait for a model before retrying on a single thread
const SR = 16000;                   // Whisper's sample rate
const LIVE_MIN_NEW = 0.8 * SR;      // new audio needed before refreshing the preview
const LIVE_COMMIT = 20 * SR;        // lock in preview text every ~20 s so updates stay quick
const SILENCE_RMS = 0.006;          // skip previews of silence (Whisper invents "Thank you." for it)
const voice = {
  worker: null, loaded: new Set(),
  // threads 0 = runtime picks (multi-threaded); 1 if multi-threading stalled here before
  threads: Number(localStorage.getItem('qc.voiceThreads')) === 1 ? 1 : 0,
  pending: new Map(),  // final transcriptions: id -> { job, r }, kept so they can be re-sent after a restart
  talkJobs: new Map(), // Talk mode transcriptions: id -> { job, resolve }
  watchdog: null, statusTimer: null,
  rec: null,           // the recording in progress
  finishing: null,     // a stopped recording whose final text is on its way
};
const composerEl = $('.composer');
// Previews: Whisper base for English/auto (~2 s per update even on one thread); small for other
// languages, because base writes Hindi in Urdu script
const previewModel = () => (!settings.voiceLang || settings.voiceLang === 'english' ? 'live' : 'fast');
// Final text: Fast mode uses the preview model (so Stop is quick); Accurate uses Whisper medium
const voiceModel = () => (settings.voiceModel === 'fast' ? previewModel() : 'accurate');

// Speech on the Mac's GPU (Whisper large-v3-turbo via the server), like hosted assistants do:
// the browser only uploads the audio, so nothing is downloaded and phones get the fast path.
// If the Mac engine is missing or fails, it falls back to Whisper inside the browser.
voice.mac = null;  // null until /voice/status answers; the Mac path is tried meanwhile
fetch('/voice/status').then((r) => (r.ok ? r.json() : {})).then((j) => { voice.mac = !!j.mac; }).catch(() => { voice.mac = false; });

function toPcm16(audio) {
  const out = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) out[i] = Math.max(-1, Math.min(1, audio[i])) * 0x7fff;
  return out.buffer;
}

// Same interface as the browser Worker (postMessage / onmessage / terminate), backed by the server
function macVoiceWorker() {
  let queue = Promise.resolve();
  const w = { onmessage: null, onerror: null, dead: false, terminate() { w.dead = true; } };
  const send = (data) => { if (!w.dead) w.onmessage?.({ data }); };
  w.postMessage = (msg) => {
    if (msg.type === 'load') return setTimeout(() => send({ type: 'ready', model: msg.model }));
    if (msg.type !== 'transcribe') return;
    queue = queue.then(async () => {
      if (w.dead) return;
      try {
        const res = await fetch(`/voice/transcribe?lang=${encodeURIComponent(msg.language || '')}`, { method: 'POST', body: toPcm16(msg.audio) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        send({ type: 'result', id: msg.id, text: j.text || '' });
      } catch (e) {
        if (w.dead || voice.worker !== w) return;
        // Mac engine unavailable: switch to the in-browser engine and redo this job there
        console.warn('Mac speech model failed, using the browser instead:', e.message);
        voice.mac = false;
        w.dead = true;
        voice.worker = null;
        voiceWorker().postMessage({ ...msg, threads: voice.threads || undefined });
      }
    });
  };
  return w;
}

function voiceWorker() {
  if (voice.worker) return voice.worker;
  const onMac = voice.mac !== false;
  const w = voice.worker = onMac ? macVoiceWorker() : new Worker('voice-worker.js?v=2', { type: 'module' });
  voice.loaded = new Set();
  const threads = voice.threads || undefined;
  // Multi-threaded start-up stalls in some browsers. If loading makes no progress for a while,
  // restart on one thread. Progress (e.g. a slow download on a phone) resets the timer, so a
  // large model over a remote link isn't mistaken for a stall.
  const arm = () => { clearTimeout(voice.watchdog); voice.watchdog = setTimeout(stalled, VOICE_START_TIMEOUT); };
  const stalled = () => {
    if (voice.loaded.size || voice.worker !== w) return;
    w.terminate();
    voice.worker = null;
    if (voice.threads === 1) return failVoice('The speech model didn’t start. Try reloading the page.');
    voice.threads = 1;
    // Remember it: in this browser multi-threaded start-up stalls, so later visits skip the wait
    try { localStorage.setItem('qc.voiceThreads', '1'); } catch {}
    if (voice.rec) voice.rec.liveInFlight = null;  // that preview is lost; the next tick sends another
    const again = voiceWorker();
    for (const { job } of voice.pending.values()) again.postMessage({ type: 'transcribe', threads: 1, ...job });
    for (const { job } of voice.talkJobs.values()) again.postMessage({ type: 'transcribe', threads: 1, ...job });
  };
  if (!onMac) arm();  // the Mac path has no download or start-up to watch
  w.onmessage = ({ data }) => {
    if (w !== voice.worker) return;  // a replaced worker
    if (data.type === 'loading' && !voice.loaded.has(data.model)) {
      if (!voice.loaded.size) arm();  // still downloading: not a stall
      showVoiceStatus(`Loading speech model… ${Math.round(data.progress * 100)}%`);
    }
    else if (data.type === 'ready') { voice.loaded.add(data.model); clearTimeout(voice.watchdog); updateVoiceStatus(); }
    else if (data.type === 'result' || data.type === 'error') {
      if (voice.rec?.liveInFlight?.id === data.id) return onLiveResult(voice.rec, data.type === 'result' ? data.text : null);
      const tj = voice.talkJobs.get(data.id);
      if (tj) { voice.talkJobs.delete(data.id); return tj.resolve(data.type === 'result' ? data.text : null); }
      const entry = voice.pending.get(data.id);
      if (!entry) return;  // a preview for a recording that has since stopped
      voice.pending.delete(data.id);
      if (data.type === 'error') toast(`Voice input failed: ${data.message}`);
      finishTranscript(entry.r, data.type === 'result' ? data.text : null);
      updateVoiceStatus();
    }
  };
  w.onerror = (e) => { if (w === voice.worker) failVoice(`Voice input failed to start: ${e.message || 'worker error'}`); };
  // Load the preview model first (needed within a second of speaking), then the final-pass model
  w.postMessage({ type: 'load', threads, model: previewModel() });
  if (voiceModel() !== previewModel()) w.postMessage({ type: 'load', threads, model: voiceModel() });
  return w;
}

function failVoice(message) {
  clearTimeout(voice.watchdog);
  voice.worker?.terminate();
  voice.worker = null;
  for (const { r } of voice.pending.values()) finishTranscript(r, null);
  voice.pending.clear();
  for (const { resolve } of voice.talkJobs.values()) resolve(null);
  voice.talkJobs.clear();
  updateVoiceStatus();
  toast(message);
}

// Status next to the mic after you press Stop: "Transcribing… 12s" → hidden
function updateVoiceStatus() {
  if (!voice.pending.size) {
    clearInterval(voice.statusTimer);
    voice.statusTimer = null;
    return showVoiceStatus(null);
  }
  if (!voice.statusTimer) voice.statusTimer = setInterval(updateVoiceStatus, 1000);
  const { job } = [...voice.pending.values()][0];
  const secs = Math.floor((Date.now() - job.queued) / 1000);
  showVoiceStatus(voice.loaded.has(job.model) ? `Transcribing… ${secs}s` : `Loading speech model… ${secs}s`);
}

function showVoiceStatus(text) {
  $('#voice-status').hidden = !text;
  $('#voice-status-text').textContent = text || '';
  composerEl.classList.toggle('voice-busy', !!text);
}

// ----- Text in the message box -----
const joinText = (a, b) => (a && b ? `${a} ${b}` : a || b || '');

// Put `text` where the cursor was when recording started, spaced from the text around it
function showInComposer(r, text) {
  const pre = text && r.before && !/\s$/.test(r.before) ? ' ' : '';
  const post = text && r.after && !/^\s/.test(r.after) ? ' ' : '';
  els.input.value = r.before + pre + text + post + r.after;
  autosize();
  return (r.before + pre + text + post).length;  // caret position after the text
}

function finishTranscript(r, text) {
  voice.finishing = null;
  // If the final pass failed or came back empty, keep what the live preview heard
  const final = (text || '').trim() || joinText(r.committedText, r.liveText);
  const caret = showInComposer(r, final);
  els.input.readOnly = false;
  composerEl.classList.remove('live');
  els.input.focus();
  els.input.setSelectionRange(caret, caret);
  if (!final) toast('Didn’t catch anything — try speaking a bit louder or closer');
  if (voice.sendWhenDone) {  // Send was pressed while this was being transcribed
    voice.sendWhenDone = false;
    if (els.input.value.trim()) send(els.input.value);
  }
}

// ----- Recording -----
// Linear-interpolate incoming mic audio (usually 44.1 or 48 kHz) down to 16 kHz as it arrives
function pushAudio(r, chunk) {
  const ratio = r.rate / SR;
  const at = (i) => (i < r.srcPos ? r.prevSample : chunk[i - r.srcPos]);
  const endPos = r.srcPos + chunk.length;
  while (r.nextT < endPos - 1 && r.len < r.audio.length) {
    const i = Math.floor(r.nextT), f = r.nextT - i;
    const a = at(i), b = at(i + 1);
    r.audio[r.len++] = a + (b - a) * f;
    r.nextT += ratio;
  }
  r.prevSample = chunk[chunk.length - 1];
  r.srcPos = endPos - 1;  // keep the last sample to interpolate across chunk boundaries
  if (r.nextT < r.srcPos) r.nextT = r.srcPos;
}

function rms(a) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / (a.length || 1));
}

// Every few hundred ms: if there's enough new speech, ask for a fresh preview of the uncommitted audio
function liveTick(r) {
  if (voice.rec !== r || r.liveInFlight) return;
  if (r.len - r.liveEnd < LIVE_MIN_NEW || r.len - r.committedAt < SR) return;
  const audio = r.audio.slice(r.committedAt, r.len);
  if (rms(audio) < SILENCE_RMS) { r.liveEnd = r.len; return; }
  r.liveInFlight = { id: Date.now() + Math.random(), start: r.committedAt, end: r.len };
  voiceWorker().postMessage({ type: 'transcribe', threads: voice.threads || undefined, id: r.liveInFlight.id, audio, model: previewModel(), language: settings.voiceLang || null });
}

function onLiveResult(r, text) {
  const { start, end } = r.liveInFlight;
  r.liveInFlight = null;
  r.liveEnd = end;
  if (text == null) return;  // a failed preview; the next tick tries again
  if (end - start >= LIVE_COMMIT) {
    r.committedText = joinText(r.committedText, text);
    r.committedAt = end;
    r.liveText = '';
  } else {
    r.liveText = text;
  }
  showInComposer(r, joinText(r.committedText, r.liveText));
  els.input.scrollTop = els.input.scrollHeight;
  liveTick(r);  // more audio may already be waiting
}

async function startRecording() {
  if (voice.rec) return;
  if (talk.on) return toast('End the voice conversation first');
  if (voice.finishing) return toast('Still transcribing your last recording…');
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) return toast('This browser doesn’t support voice recording');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    return toast(err.name === 'NotAllowedError'
      ? 'Microphone access is blocked — allow it for localhost in your browser’s site settings'
      : err.name === 'NotFoundError' ? 'No microphone found' : `Couldn’t start the microphone: ${err.message}`);
  }
  const ctx = new AudioContext();
  try {
    await ctx.audioWorklet.addModule('voice-capture.js');
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    return toast(`Couldn’t start recording: ${err.message}`);
  }
  voiceWorker();  // starts loading the models while you talk

  const ta = els.input;
  const selStart = ta.selectionStart ?? ta.value.length, selEnd = ta.selectionEnd ?? ta.value.length;
  const r = voice.rec = {
    stream, ctx, rate: ctx.sampleRate, started: Date.now(),
    audio: new Float32Array((MAX_REC_SECS + 2) * SR), len: 0, srcPos: 0, nextT: 0, prevSample: 0,
    before: ta.value.slice(0, selStart), after: ta.value.slice(selEnd),
    committedText: '', committedAt: 0, liveText: '', liveEnd: 0, liveInFlight: null,
  };
  const src = ctx.createMediaStreamSource(stream);
  r.node = new AudioWorkletNode(ctx, 'capture');
  r.node.port.onmessage = (e) => { if (voice.rec === r) pushAudio(r, e.data); };
  const mute = ctx.createGain();
  mute.gain.value = 0;  // keeps the node running without playing your voice back
  src.connect(r.node).connect(mute).connect(ctx.destination);

  // Level meter so you can see the mic is hearing you
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize), bars = [...document.querySelectorAll('#level i')];
  const meter = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
    bars.forEach((b, i) => { b.style.height = 4 + Math.max(0, level * 12 * (1 - Math.abs(i - 3) / 4.5)) + 'px'; });
    r.meter = requestAnimationFrame(meter);
  };
  meter();

  const updateTime = () => {
    const secs = Math.floor((Date.now() - r.started) / 1000);
    $('#rec-time').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    if (secs >= MAX_REC_SECS) { toast('Recording stopped at 5 minutes'); stopRecording(); }
  };
  updateTime();
  r.timer = setInterval(updateTime, 250);
  r.liveTimer = setInterval(() => liveTick(r), 300);

  ta.readOnly = true;  // the live text goes here; typing would fight with it
  composerEl.classList.add('recording', 'live');
  $('#rec').hidden = false;
  $('#rec-stop').focus();
}

function stopRecording(cancel = false) {
  const r = voice.rec;
  if (!r) return;
  voice.rec = null;
  r.stream.getTracks().forEach((t) => t.stop());
  r.node.port.onmessage = null;
  r.ctx.close();
  cancelAnimationFrame(r.meter);
  clearInterval(r.timer);
  clearInterval(r.liveTimer);
  $('#rec').hidden = true;
  composerEl.classList.remove('recording');

  if (cancel) return restoreComposer(r);
  if (r.len < 0.6 * SR) { restoreComposer(r); return toast('Recording was too short'); }

  // Fast mode: if the last preview already covers all the audio, it *is* the final text
  if (settings.voiceModel === 'fast' && !r.liveInFlight && r.committedAt === 0 && r.liveEnd === r.len && r.liveText) {
    return finishTranscript(r, r.liveText);
  }
  voice.finishing = r;
  const job = { id: Date.now() + Math.random(), audio: r.audio.slice(0, r.len), model: voiceModel(), language: settings.voiceLang || null, queued: Date.now() };
  voice.pending.set(job.id, { job, r });
  voiceWorker().postMessage({ type: 'transcribe', threads: voice.threads || undefined, ...job });  // copied, so it can be re-sent
  updateVoiceStatus();
}

// Put the message box back exactly as it was before recording
function restoreComposer(r) {
  voice.sendWhenDone = false;  // cancelled or too short: nothing to send
  els.input.value = r.before + r.after;
  els.input.readOnly = false;
  composerEl.classList.remove('live');
  autosize();
  els.input.focus();
  els.input.setSelectionRange(r.before.length, r.before.length);
}

$('#mic').onclick = startRecording;
const voiceLang = $('#voice-lang');
voiceLang.value = settings.voiceLang || '';
if (voiceLang.value !== (settings.voiceLang || '')) voiceLang.value = '';  // unknown saved value
voiceLang.onchange = () => {
  settings.voiceLang = voiceLang.value;
  saveSettings();
  if (voice.worker && !voice.loaded.has(previewModel())) voice.worker.postMessage({ type: 'load', threads: voice.threads || undefined, model: previewModel() });
};
function setVoiceSpeed(v) {
  settings.voiceModel = v === 'fast' ? 'fast' : 'accurate';
  saveSettings();
  document.querySelectorAll('#voice-speed button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.speed === settings.voiceModel)));
  // Start loading the newly chosen model while you're still talking
  if (voice.worker && !voice.loaded.has(voiceModel())) voice.worker.postMessage({ type: 'load', threads: voice.threads || undefined, model: voiceModel() });
}
document.querySelectorAll('#voice-speed button').forEach((b) => (b.onclick = () => setVoiceSpeed(b.dataset.speed)));
setVoiceSpeed(settings.voiceModel);
$('#rec-stop').onclick = () => stopRecording(false);
$('#rec-cancel').onclick = () => stopRecording(true);
addEventListener('keydown', (e) => {
  if (!voice.rec) return;
  // Runs before other key handlers (capture phase) so Enter/Esc don't also send the message or close things
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopRecording(true); }
  else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); stopRecording(false); }
}, true);
