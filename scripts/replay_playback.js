/* Replays captured agent replies through a playback worklet offline and writes what the user would hear.

   Traces come from `python -m scripts.voice_latency capture` (scripts/traces/<silence>/<name>.pcm + .json).
   Delivery is either the real arrival times from the capture, or the same audio re-timed to a steady
   rate (e.g. 0.8× real time) in 100 ms bursts. Prints gaps per reply and writes WAVs to scripts/traces/out/.

   Usage (from the repo root):
     node scripts/replay_playback.js --worklet HEAD --worklet frontend/js/playback_worklet.js --rate 0.8
     node scripts/replay_playback.js --worklet 798159d --rate real --traces scripts/traces/1400-4000
   --worklet takes a file path or a git revision (reads frontend/js/playback_worklet.js at that revision).
*/

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const SR = 24000;
const QUANTUM = 128;
const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
    const all = process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1]] : []));
    return all.length ? all : fallback;
}

function loadWorklet(spec) {
    const src = fs.existsSync(spec)
        ? fs.readFileSync(spec, 'utf8')
        : execSync(`git show ${spec}:frontend/js/playback_worklet.js`, { cwd: ROOT }).toString();
    let Cls;
    const ctx = {
        sampleRate: SR, Math, Set, Number,
        AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => this.sent.push(m), onmessage: null }; this.sent = []; } },
        registerProcessor: (_, C) => { Cls = C; },
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    return Cls;
}

/* [[arrival_s, Float32Array]] for one trace. rate 'real' keeps the captured timing. */
function delivery(pcm, chunks, rate) {
    const out = [];
    let pos = 0;
    chunks.forEach(([t, n], i) => {
        const f = new Float32Array(n);
        for (let k = 0; k < n; k++) f[k] = pcm[pos + k] / 0x8000;
        pos += n;
        // Steady rate in 100 ms bursts: each burst arrives when the source has produced all of it.
        const at = rate === 'real' ? t : (Math.floor(i / 10) + 1) * 10 * (n / SR) / rate;
        out.push([at, f]);
    });
    return out;
}

function play(Cls, chunks, startS) {
    // rebufferS/stepS/maxS are only read by the 798159d worklet, which took them as options.
    const node = new Cls({ processorOptions: { startS, rebufferS: 0.5, stepS: 0.2, maxS: 1.0 } });
    const send = m => node.port.onmessage({ data: m });
    const endAt = chunks[chunks.length - 1][0];
    const audioS = chunks.reduce((s, [, f]) => s + f.length, 0) / SR;
    const quanta = Math.ceil((endAt + audioS + 3) * SR / QUANTUM);
    const y = new Float32Array(quanta * QUANTUM);
    let ci = 0;
    let ended = false;
    for (let q = 0; q < quanta; q++) {
        const now = q * QUANTUM / SR;
        while (ci < chunks.length && chunks[ci][0] <= now) send({ type: 'push', seg: 1, samples: chunks[ci++][1] });
        if (!ended && ci === chunks.length) { send({ type: 'end', seg: 1 }); ended = true; }
        const buf = new Float32Array(QUANTUM);
        node.process([], [[buf]]);
        y.set(buf, q * QUANTUM);
    }
    return { y, sent: node.sent };
}

/* Silent runs (≥ 5 ms) between the first and last sound, counted in the output minus those already in
   the source audio: what playback added. */
function quietRuns(a) {
    let first = 0, last = a.length - 1;
    while (first < a.length && Math.abs(a[first]) < 1e-4) first++;
    while (last > first && Math.abs(a[last]) < 1e-4) last--;
    let runs = 0, samples = 0, run = 0;
    for (let i = first; i <= last + 1; i++) {
        if (i <= last && Math.abs(a[i]) < 1e-4) run++;
        else { if (run >= 0.005 * SR) { runs++; samples += run; } run = 0; }
    }
    return { first, runs, samples };
}

function maxJump(a) {
    let m = 0;
    for (let i = 1; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
    return m;
}

function measure(y, src) {
    const o = quietRuns(y), s = quietRuns(src);
    return {
        firstMs: Math.round(o.first / SR * 1000),
        gaps: Math.max(0, o.runs - s.runs),
        silenceMs: Math.max(0, Math.round((o.samples - s.samples) / SR * 1000)),
        // Largest sample-to-sample jump, output vs source: well above the source means a click.
        jump: `${maxJump(y).toFixed(2)}/${maxJump(src).toFixed(2)}`,
    };
}

function writeWav(file, y) {
    const pcm = Buffer.alloc(y.length * 2);
    for (let i = 0; i < y.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y[i] * 32767))), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

const worklets = arg('worklet', ['HEAD', 'frontend/js/playback_worklet.js']);
const rateArg = arg('rate', ['0.8'])[0];
const rate = rateArg === 'real' ? 'real' : Number(rateArg);
const traceDirs = arg('traces', ['scripts/traces/1400-4000', 'scripts/traces/1000-2000']);
const startS = Number(arg('start', ['0.3'])[0]);

for (const spec of worklets) {
    const Cls = loadWorklet(spec);
    const label = spec.replace(/[\\/.:]+/g, '_');
    let totGaps = 0, totSilence = 0, n = 0;
    console.log(`\n=== worklet ${spec}, delivery ${rate === 'real' ? 'as captured' : `${rate}×`}`);
    for (const dir of traceDirs) {
        for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
            const name = f.slice(0, -5);
            const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const buf = fs.readFileSync(path.join(dir, `${name}.pcm`));
            const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
            const src = Float32Array.from(pcm, v => v / 0x8000);
            const { y, sent } = play(Cls, delivery(pcm, meta.chunks, rate), startS);
            const m = measure(y, src);
            totGaps += m.gaps; totSilence += m.silenceMs; n++;
            console.log(`${path.basename(dir)}/${name}`.padEnd(28)
                + ` audio ${(src.length / SR).toFixed(1)}s  first sound ${m.firstMs} ms  gaps ${m.gaps}  inserted silence ${m.silenceMs} ms  max jump ${m.jump}`
                + `  underrun msgs ${sent.filter(s => s.type === 'underrun').length}`);
            writeWav(path.join(ROOT, 'scripts/traces/out', `${rateArg}x`, label, `${path.basename(dir)}-${name}.wav`), y);
        }
    }
    console.log(`total: ${totGaps} gaps, ${totSilence} ms inserted silence over ${n} replies`);
}
