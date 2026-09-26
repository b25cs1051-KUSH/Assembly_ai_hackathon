/* =================================================================
   Mic worklet — runs on the audio thread. Resamples mic audio from the
   AudioContext's native rate to 24 kHz, converts it to PCM16 and posts
   ~50 ms chunks to the main thread.
   It also runs a small energy detector: it posts 'speech' as soon as the
   user starts talking and 'silence' once they stop, so playback can stay
   ducked for exactly as long as the user talks, before the server confirms.
   Resampling here (instead of creating a 24 kHz AudioContext) keeps it
   working in Firefox, which rejects mic sources at a non-native rate.
   ================================================================= */

const TARGET_RATE = 24000;
const CHUNK_SAMPLES = 1200; // 50 ms at 24 kHz
const SPEECH_HOLD_S = 0.06;   // loud this long → speech
const QUIET_RESET_S = 0.3;    // quiet this long → ready to detect again

class MicProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        // RMS level (0–1) counted as speech; set from the page so it can be tuned.
        this.speechRms = (options.processorOptions && options.processorOptions.speechRms) || 0.03;
        this.loudS = 0;
        this.quietS = 0;
        this.inSpeech = false;
        // The page raises the threshold when the agent's own echo keeps tripping the detector.
        this.port.onmessage = e => { if (e.data && e.data.threshold) this.speechRms = e.data.threshold; };
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

    detectSpeech(x) {
        let sum = 0;
        for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
        const blockS = x.length / sampleRate;
        if (Math.sqrt(sum / x.length) >= this.speechRms) {
            this.loudS += blockS;
            this.quietS = 0;
            if (!this.inSpeech && this.loudS >= SPEECH_HOLD_S) {
                this.inSpeech = true;
                this.port.postMessage('speech');
            }
        } else {
            this.quietS += blockS;
            if (this.quietS >= QUIET_RESET_S) {
                if (this.inSpeech) this.port.postMessage('silence');
                this.loudS = 0;
                this.inSpeech = false;
            }
        }
    }

    process(inputs) {
        const x = inputs[0] && inputs[0][0];
        if (!x || !x.length) return true;
        const n = x.length;
        this.detectSpeech(x);

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
