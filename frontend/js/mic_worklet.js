/* =================================================================
   Mic worklet — runs on the audio thread. Resamples mic audio from the
   AudioContext's native rate to 24 kHz, converts it to PCM16 and posts
   ~50 ms chunks to the main thread.
   Resampling here (instead of creating a 24 kHz AudioContext) keeps it
   working in Firefox, which rejects mic sources at a non-native rate.
   ================================================================= */

const TARGET_RATE = 24000;
const CHUNK_SAMPLES = 1200; // 50 ms at 24 kHz

class MicProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.step = sampleRate / TARGET_RATE;  // input samples per output sample
        this.pos = 0;                          // next output position, relative to the current block
        this.prev = 0;                         // last sample of the previous block (position -1)
        this.buffer = new Int16Array(CHUNK_SAMPLES);
        this.offset = 0;
    }

    push(sample) {
        const s = Math.max(-1, Math.min(1, sample));
        this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.offset === CHUNK_SAMPLES) {
            this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
            this.buffer = new Int16Array(CHUNK_SAMPLES);
            this.offset = 0;
        }
    }

    process(inputs) {
        const x = inputs[0] && inputs[0][0];
        if (!x || !x.length) return true;
        const n = x.length;

        // Linear interpolation; position -1 is the previous block's last sample.
        while (this.pos <= n - 1) {
            const i = Math.floor(this.pos);
            const frac = this.pos - i;
            const a = i < 0 ? this.prev : x[i];
            this.push(frac === 0 ? a : a + (x[i + 1] - a) * frac);
            this.pos += this.step;
        }
        this.pos -= n;
        this.prev = x[n - 1];
        return true;
    }
}

registerProcessor('mic-processor', MicProcessor);
