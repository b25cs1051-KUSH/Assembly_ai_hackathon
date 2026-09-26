/* =================================================================
   Playback worklet — plays the agent's audio as one continuous stream
   (24 kHz context, so no resampling here).
   Reply audio arrives in ~10 ms chunks, in bursts and sometimes slower
   than real time. Instead of scheduling a node per chunk (where every
   late chunk is an audible gap), chunks go into a queue:
   - a segment (reply or acknowledgement clip) starts playing once startS
     of audio is buffered, or at once if it is complete and shorter;
   - after that, chunks play back to back with no further waiting; if the
     queue runs dry mid-reply (underrun), playback continues the instant
     the next chunk arrives.
   Messages in:  {type:'push', seg, samples: Float32Array}
                 {type:'end', seg}   no more audio for this segment
                 {type:'clear'}      drop everything (barge-in)
   Messages out: {type:'playing'} {type:'idle'} {type:'underrun'}
   ================================================================= */

class PlaybackProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = options.processorOptions;
        this.startS = o.startS;
        this.dry = false;         // ran out mid-reply and waiting for the next chunk
        this.queue = [];          // { seg, samples }
        this.offset = 0;          // read position in queue[0]
        this.buffered = 0;        // samples queued
        this.ended = new Set();   // segments that will get no more audio
        this.state = 'idle';      // idle | buffering | playing
        this.need = 0;            // samples to buffer before a segment starts
        this.lastSeg = null;      // segment of the last sample played
        this.port.onmessage = e => this.onMessage(e.data);
    }

    onMessage(m) {
        if (m.type === 'push') {
            this.queue.push({ seg: m.seg, samples: m.samples });
            this.buffered += m.samples.length;
            if (this.state === 'idle') this.wait(this.startS);
        } else if (m.type === 'end') {
            this.ended.add(m.seg);
        } else if (m.type === 'clear') {
            this.queue = [];
            this.offset = 0;
            this.buffered = 0;
            this.dry = false;
            this.setIdle();
        }
    }

    wait(seconds) {
        this.state = 'buffering';
        this.need = Math.round(seconds * sampleRate);
    }

    setIdle() {
        if (this.state !== 'idle') this.port.postMessage({ type: 'idle' });
        this.state = 'idle';
    }

    process(inputs, outputs) {
        const out = outputs[0][0];
        if (this.state === 'buffering') {
            // Start once enough is buffered, or right away if the queued audio is all there will be.
            const last = this.queue[this.queue.length - 1];
            if (this.buffered >= this.need || (last && this.ended.has(last.seg))) {
                this.state = 'playing';
                this.port.postMessage({ type: 'playing' });
            }
        }
        if (this.state !== 'playing') { out.fill(0); return true; }

        let i = 0;
        while (i < out.length && this.queue.length) {
            const head = this.queue[0];
            const n = Math.min(out.length - i, head.samples.length - this.offset);
            out.set(head.samples.subarray(this.offset, this.offset + n), i);
            i += n;
            this.offset += n;
            this.buffered -= n;
            this.lastSeg = head.seg;
            this.dry = false;
            if (this.offset === head.samples.length) { this.queue.shift(); this.offset = 0; }
        }
        if (i < out.length) {
            out.fill(0, i);
            if (this.lastSeg !== null && !this.ended.has(this.lastSeg)) {
                // Ran dry in the middle of a reply: keep playing silence and continue the instant
                // the next chunk arrives. Reported once per dry spell.
                if (!this.dry) this.port.postMessage({ type: 'underrun' });
                this.dry = true;
            } else if (this.queue.length) {
                this.wait(this.startS);  // next segment already queued: normal hand-over
            } else {
                this.setIdle();
            }
        }
        return true;
    }
}

registerProcessor('playback-processor', PlaybackProcessor);
