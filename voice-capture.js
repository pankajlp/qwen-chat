// AudioWorklet that hands raw microphone samples to the page in ~0.1 s batches,
// so speech can be transcribed while you're still talking.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      if (this.len + ch.length > this.buf.length) {
        this.port.postMessage(this.buf.slice(0, this.len));
        this.len = 0;
      }
      this.buf.set(ch, this.len);
      this.len += ch.length;
    }
    return true;
  }
}
registerProcessor('capture', Capture);
