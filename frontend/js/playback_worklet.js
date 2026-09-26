/* =================================================================
   Playback worklet — plays the agent's audio as one continuous stream
   (24 kHz context, so no resampling here).
   Reply audio arrives in ~10 ms chunks, in bursts and sometimes slower
   than real time (we measured 0.8×). Instead of scheduling a node per
   chunk (where every late chunk is an audible gap), chunks go into a queue:
   - a segment (reply or acknowledgement clip) starts playing once startS
     of audio is buffered, or at once if it is complete and shorter;
   - while audio keeps up, chunks play back to back with no extra delay;
   - if a reply is about to run dry mid-reply (underrun), it fades out over
     ~5 ms and waits until REBUFFER_S is buffered, then fades back in. One
     short pause instead of chopping every chunk. Each underrun adds
     STEP_S to both waits, up to MAX_S, for the rest of the session.
   Messages in:  {type:'push', seg, samples: Float32Array}
                 {type:'end', seg}   no more audio for this segment
                 {type:'clear'}      drop everything (barge-in)
   Messages out: {type:'playing'} {type:'idle'} {type:'underrun', needMs}
   ================================================================= */

// Replayed on captured replies at 0.8× delivery: about 2 pauses per reply, against 40–50 micro-gaps
// when each chunk plays the moment it arrives (scripts/replay_playback.js).
const REBUFFER_S = 0.5;   // buffered before continuing after an underrun
const STEP_S = 0.2;       // each underrun adds this to the start and rebuffer waits…
const MAX_S = 1.0;        // …up to this
const FADE = 128;         // ~5 ms fade out before a pause and in after it, so it doesn't click

class PlaybackProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = options.processorOptions;
        this.startS = o.startS;
        this.underruns = 0;       // this session; makes every later wait longer
        this.queue = [];          // { seg, samples }
        this.offset = 0;          // read position in queue[0]
        this.buffered = 0;        // samples queued
        this.ended = new Set();   // segments that will get no more audio
        this.state = 'idle';      // idle | buffering | playing
        this.need = 0;            // samples to buffer before (re)starting
        this.resuming = false;    // buffering after an underrun, not at a segment start
        this.fadeIn = 0;          // samples of fade-in left
        this.lastSeg = null;      // segment of the last sample played
        this.port.onmessage = e => this.onMessage(e.data);
    }

    onMessage(m) {
        if (m.type === 'push') {
            this.queue.push({ seg: m.seg, samples: m.samples });
            this.buffered += m.samples.length;
            if (this.state === 'idle') this.wait(this.startNeedS());
        } else if (m.type === 'end') {
            this.ended.add(m.seg);
        } else if (m.type === 'clear') {
            this.queue = [];
            this.offset = 0;
            this.buffered = 0;
            this.resuming = false;
            this.fadeIn = 0;
            this.setIdle();
        }
    }

    startNeedS() {
        return Math.min(MAX_S, this.startS + STEP_S * this.underruns);
    }

    wait(seconds) {
        this.state = 'buffering';
        this.need = Math.round(seconds * sampleRate);
    }

    setIdle() {
        if (this.state !== 'idle') this.port.postMessage({ type: 'idle' });
        this.state = 'idle';
    }

    /* True while the queued audio is not the whole segment yet: more is coming for the one playing. */
    midReply() {
        const last = this.queue[this.queue.length - 1];
        const seg = last ? last.seg : this.lastSeg;
        return seg !== null && !this.ended.has(seg);
    }

    process(inputs, outputs) {
        const out = outputs[0][0];
        if (this.state === 'buffering') {
            // Start once enough is buffered, or right away if the queued audio is all there will be.
            const last = this.queue[this.queue.length - 1];
            if (this.buffered >= this.need || (last && this.ended.has(last.seg))) {
                this.state = 'playing';
                if (this.resuming) this.fadeIn = FADE;
                else this.port.postMessage({ type: 'playing' });
                this.resuming = false;
            }
        }
        if (this.state !== 'playing') { out.fill(0); return true; }

        // About to run dry mid-reply: play what is left of this quantum fading out, then rebuffer.
        const starving = this.midReply() && this.buffered < out.length + FADE;
        const take = Math.min(out.length, this.buffered);

        let i = 0;
        while (i < take) {
            const head = this.queue[0];
            const n = Math.min(take - i, head.samples.length - this.offset);
            out.set(head.samples.subarray(this.offset, this.offset + n), i);
            i += n;
            this.offset += n;
            this.buffered -= n;
            this.lastSeg = head.seg;
            if (this.offset === head.samples.length) { this.queue.shift(); this.offset = 0; }
        }
        for (let k = 0; k < i && this.fadeIn > 0; k++, this.fadeIn--) out[k] *= 1 - this.fadeIn / FADE;
        if (starving) for (let k = 0; k < i; k++) out[k] *= 1 - (k + 1) / i;
        out.fill(0, i);

        if (starving) {
            this.underruns++;
            const s = Math.min(MAX_S, REBUFFER_S + STEP_S * (this.underruns - 1));
            this.wait(s);
            this.resuming = true;
            this.port.postMessage({ type: 'underrun', needMs: Math.round(s * 1000) });
        } else if (i < out.length) {
            if (this.queue.length) this.wait(this.startNeedS());  // next segment already queued: normal hand-over
            else this.setIdle();
        }
        return true;
    }
}

registerProcessor('playback-processor', PlaybackProcessor);
