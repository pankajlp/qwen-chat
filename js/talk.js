// Talk mode: hands-free voice conversation.
// Loaded in order by index.html; all files share one global scope (classic scripts).
// ---------- Talk mode (hands-free voice conversation) ----------
// The mic stays open. A simple voice-activity detector (loudness vs the room's noise floor) spots when
// you start and stop talking; your turn is transcribed on-device, sent as a normal message (so Auto,
// Search and Verify all apply), and the reply is read aloud with the Mac's own offline voices. Start
// talking while it speaks and it stops to listen.
const TALK = { SILENCE_MS: 1200, MIN_SPEECH_MS: 250, MAX_UTTER_S: 60, PREROLL_S: 0.5, SPEAKING_KEEP_S: 1.5, BARGE_MS: 300 };
const talk = { on: false, state: 'idle', paused: false };
// Whisper tends to "hear" these in noise or silence
const JUNK_TRANSCRIPT = /^\s*(thank you( very much)?|thanks for watching|you|bye|okay|\[.*\]|\(.*\)|[.…,!?\s]*)\s*[.!]?\s*$/i;
const NOVELTY_VOICES = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy)\b/;

const newTalkBuffer = () => ({ rate: talk.rate, audio: new Float32Array((TALK.MAX_UTTER_S + 2) * SR), len: 0, srcPos: 0, nextT: 0, prevSample: 0 });
function trimPreroll(r, seconds = TALK.PREROLL_S) {  // between turns, keep only the last moment so the start of a word isn't lost
  const keep = Math.round(seconds * SR);
  if (r.len > keep * 2) { r.audio.copyWithin(0, r.len - keep, r.len); r.len = keep; }
}

function talkSetState(state, caption) {
  talk.state = state;
  $('#talk').dataset.state = state;
  $('#talk-state').textContent = {
    listening: talk.paused ? 'Paused' : 'Listening…', hearing: 'Hearing you…', transcribing: 'Transcribing…',
    thinking: 'Thinking…', speaking: 'Speaking — just talk to interrupt',
  }[state] || '';
  if (caption !== undefined) $('#talk-caption').textContent = caption;
}

async function startTalk() {
  if (talk.on) return;
  if (voice.rec) return toast('Finish the current recording first');
  if (!('speechSynthesis' in window) || !window.AudioWorkletNode) return toast('This browser can’t do voice conversations');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    return toast(err.name === 'NotAllowedError'
      ? 'Microphone access is blocked — allow it for localhost in your browser’s site settings'
      : err.name === 'NotFoundError' ? 'No microphone found' : `Couldn’t start the microphone: ${err.message}`);
  }
  const ctx = new AudioContext();
  try { await ctx.audioWorklet.addModule('voice-capture.js'); }
  catch (err) { stream.getTracks().forEach((t) => t.stop()); ctx.close(); return toast(`Couldn’t start listening: ${err.message}`); }
  voiceWorker();  // start loading the speech model now
  speechSynthesis.getVoices();  // make sure the voice list is loaded
  Object.assign(talk, { on: true, paused: false, stream, ctx, rate: ctx.sampleRate, noise: 0.004, speechMs: 0, silenceMs: 0, bargeMs: 0, inUtter: false });
  talk.r = newTalkBuffer();
  const src = ctx.createMediaStreamSource(stream);
  talk.node = new AudioWorkletNode(ctx, 'capture');
  talk.node.port.onmessage = (e) => talkChunk(e.data);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(talk.node).connect(mute).connect(ctx.destination);
  $('#talk').hidden = false;
  composerEl.classList.add('talking');
  $('#talk-pause').textContent = 'Pause';
  talkSetState('listening', 'Go ahead — say something.');
}

function endTalk() {
  if (!talk.on) return;
  talk.on = false;
  speechSynthesis.cancel();
  talk.stream.getTracks().forEach((t) => t.stop());
  talk.node.port.onmessage = null;
  talk.ctx.close();
  $('#talk').hidden = true;
  composerEl.classList.remove('talking');
  talkSetState('idle', '');
}

function talkChunk(chunk) {
  if (!talk.on) return;
  const ms = (chunk.length / talk.rate) * 1000;
  const level = rms(chunk);
  $('#talk').style.setProperty('--lvl', Math.min(1, level * 14).toFixed(3));
  const loud = level > Math.max(0.012, talk.noise * 3);
  if (!loud) talk.noise = talk.noise * 0.95 + level * 0.05;  // track the room's background level
  if (talk.paused) return;

  if (talk.state === 'speaking') {
    // Keep the last 1.5 s, and if you talk over the reply (clearly louder than the echo-cancelled
    // speaker), stop speaking and treat it as the start of your turn — including what was just kept
    pushAudio(talk.r, chunk);
    trimPreroll(talk.r, TALK.SPEAKING_KEEP_S);
    talk.bargeMs = level > Math.max(0.02, talk.noise * 5) ? talk.bargeMs + ms : 0;
    if (talk.bargeMs >= TALK.BARGE_MS) {
      speechSynthesis.cancel();
      talk.inUtter = true;
      talk.silenceMs = 0;
      talkSetState('hearing', '');
    }
    return;
  }
  if (talk.state !== 'listening' && talk.state !== 'hearing') return;  // busy transcribing or thinking
  pushAudio(talk.r, chunk);
  if (!talk.inUtter) {
    talk.speechMs = loud ? talk.speechMs + ms : 0;
    if (talk.speechMs >= TALK.MIN_SPEECH_MS) { talk.inUtter = true; talk.silenceMs = 0; talkSetState('hearing'); }
    else trimPreroll(talk.r);
  } else {
    talk.silenceMs = loud ? 0 : talk.silenceMs + ms;
    if (talk.silenceMs >= TALK.SILENCE_MS || talk.r.len >= TALK.MAX_UTTER_S * SR) finishUtterance();
  }
}

function talkTranscribe(audio) {
  return new Promise((resolve) => {
    const job = { id: Date.now() + Math.random(), audio, model: previewModel(), language: settings.voiceLang || null };
    voice.talkJobs.set(job.id, { job, resolve });
    voiceWorker().postMessage({ type: 'transcribe', threads: voice.threads || undefined, ...job });
  });
}

async function finishUtterance() {
  const r = talk.r;
  talk.r = newTalkBuffer();
  talk.inUtter = false;
  talk.speechMs = talk.bargeMs = 0;
  if (r.len < 0.5 * SR) return talkSetState('listening');
  talkSetState('transcribing', '');
  const text = (await talkTranscribe(r.audio.slice(0, r.len)) || '').trim();
  if (!talk.on) return;
  if (!text || JUNK_TRANSCRIPT.test(text)) return talkSetState('listening', 'Didn’t catch that — go ahead.');
  talkSetState('thinking', `You: ${text}`);
  while (controller) await new Promise((res) => setTimeout(res, 200));  // a reply already running finishes first
  await send(text);
  if (!talk.on) return;
  if (talk.paused) return talkSetState('listening', 'Paused — the reply is in the chat.');
  const m = current?.messages.at(-1);
  const say = m?.role === 'assistant' ? speakable(m) : '';
  if (!say) { talk.r = newTalkBuffer(); return talkSetState('listening', ''); }
  talkSetState('speaking', say);
  talk.r = newTalkBuffer();  // what's heard while speaking starts fresh (the mic was picking up the reply)
  talk.bargeMs = 0;
  await speakText(say);
  if (talk.on && talk.state === 'speaking') {
    // The reply finished. Keep the last moment of audio: if you'd already started talking, carry straight on
    if (talk.bargeMs > 0) {
      talk.inUtter = true;
      talk.silenceMs = 0;
      talkSetState('hearing', '');
    } else {
      trimPreroll(talk.r);
      talk.speechMs = 0;
      talkSetState('listening', '');
    }
  }
}

// Turn an answer into something that sounds natural read aloud
function speakable(m) {
  if (m.jev) {
    const j = m.jev, p = Math.round(j.probs[j.decision] * 100);
    return `${j.options[j.decision]}. About ${p} percent ${j.calT ? 'confidence' : 'certainty'}.`;
  }
  let t = m.content || '';
  t = t.replace(/```[\s\S]*?```/g, ' I’ve put the code in the chat. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s*\[\d{1,2}\]/g, '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|?[-:\s|]+\|?\s*$/gm, '')
    .replace(/[*_~>|#]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/([.!?])\s*[.,]\s*/g, '$1 ')
    .replace(/\s+/g, ' ').trim();
  if (m.consistency && m.consistency.agree < CONSIST_OK) t = `I'm not sure about this. ${t}`;
  return t;
}

function pickVoice(text) {
  const voices = speechSynthesis.getVoices().filter((v) => v.localService && !NOVELTY_VOICES.test(v.name));
  if (/[ऀ-ॿ]/.test(text)) return voices.find((v) => /^hi[-_]/i.test(v.lang)) || null;  // Hindi → Lekha
  const def = voices.find((v) => v.default);
  if (def && /^en[-_]/i.test(def.lang)) return def;  // your Mac's default English voice
  return voices.find((v) => /^en[-_]US/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
}

// Speak in sentence-sized pieces (long utterances can cut out), stopping as soon as Talk leaves "speaking"
function speakText(text) {
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const pieces = [];
    for (const sentence of text.match(/[^.!?।]+[.!?।]*\s*/g) || [text]) {
      if (pieces.length && (pieces.at(-1) + sentence).length < 220) pieces[pieces.length - 1] += sentence;
      else pieces.push(sentence);
    }
    const v = pickVoice(text);
    let i = 0;
    const next = () => {
      if (!talk.on || talk.state !== 'speaking' || i >= pieces.length) return resolve();
      const u = new SpeechSynthesisUtterance(pieces[i++]);
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 1.05;
      u.onend = next;
      u.onerror = next;
      speechSynthesis.speak(u);
    };
    next();
  });
}

$('#talk-btn').onclick = startTalk;
$('#talk-end').onclick = endTalk;
// Pause = mute the mic (and stop any speech); a reply that's being worked out still appears in the chat
$('#talk-pause').onclick = () => {
  talk.paused = !talk.paused;
  $('#talk-pause').textContent = talk.paused ? 'Resume' : 'Pause';
  if (['listening', 'hearing', 'speaking'].includes(talk.state)) {
    if (talk.state === 'speaking') speechSynthesis.cancel();
    talk.inUtter = false;
    talk.r = newTalkBuffer();
    talkSetState('listening');
  }
};
addEventListener('keydown', (e) => { if (e.key === 'Escape' && talk.on && !voice.rec) endTalk(); });
