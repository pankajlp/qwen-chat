// Speech-to-text with Whisper, running fully on-device (no network) in a Web Worker.
import { pipeline, env } from './vendor/transformers/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
// On this Mac the files are already local, so don't keep a second copy. Opened from another device
// (the Tailscale links), cache them so the download (77 MB to 1 GB) happens once, not on every visit.
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);
env.useBrowserCache = !LOCAL && 'caches' in self;
env.localModelPath = new URL('./vendor/models/', self.location.href).href;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/transformers/', self.location.href).href;

// live = quick English previews while you talk; fast / accurate = the final text for each mode
// (non-English previews use `fast`, since base writes Hindi in Urdu script)
const MODELS = { live: 'whisper-base', fast: 'whisper-small', accurate: 'whisper-medium' };
const pipes = {};  // model key -> Promise<pipeline>; all can stay loaded (~1.4 GB together)
let threadsSet = false;

function load(model, threads) {
  // Thread count must be set before the first model is created. The page restarts this worker with
  // threads = 1 if multi-threaded start-up stalls (it does in some browsers).
  if (!threadsSet) { if (threads) env.backends.onnx.wasm.numThreads = threads; threadsSet = true; }
  const key = MODELS[model] ? model : 'accurate';
  pipes[key] ??= pipeline('automatic-speech-recognition', MODELS[key], {
    dtype: 'q8',
    device: 'wasm',  // WebGPU produces garbage output with these 8-bit weights
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) postMessage({ type: 'loading', model: key, progress: p.loaded / p.total });
    },
  }).catch((err) => { delete pipes[key]; throw err; });
  return pipes[key].then((p) => { postMessage({ type: 'ready', model: key }); return p; });
}

async function handle(data) {
  try {
    if (data.type === 'load') {
      await load(data.model, data.threads);
    } else if (data.type === 'transcribe') {
      const transcriber = await load(data.model, data.threads);
      const out = await transcriber(data.audio, {
        task: 'transcribe',
        language: data.language || null,  // null = detect automatically
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      postMessage({ type: 'result', id: data.id, text: (out.text || '').trim() });
    }
  } catch (err) {
    postMessage({ type: 'error', id: data.id, message: err?.message || String(err) });
  }
}

// One message at a time, in order: a final transcription waits behind at most one live preview
let queue = Promise.resolve();
self.onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };
