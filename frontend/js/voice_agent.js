/* =================================================================
   VoiceAgent — browser ↔ AssemblyAI Voice Agent API
   Mic → PCM16 24 kHz → input.audio; reply.audio → playback worklet
   (continuous stream, 300 ms head start per reply, playback_worklet.js).
   On tool.call a pre-recorded acknowledgement in the agent's voice plays at
   once, so the user hears a reply while the model is still working.
   Barge-in ("pause, then let the server decide"): agent audio plays in its
   own AudioContext. When the local detector (or the server) hears the user,
   that context is suspended at once, so the agent stops mid-word and no
   audio is lost. Echo stops the moment our output stops, so if the mic goes
   quiet within PROBE_MS it was echo and playback resumes. Otherwise the held
   audio is discarded only when the server says the reply was interrupted
   (or starts a new one); if the server never reacts, playback resumes.
   Add ?debug=1 to the URL for an on-screen log of audio timing.
   Docs: https://www.assemblyai.com/docs/voice-agents/voice-agent-api
   ================================================================= */

const VoiceAgent = (() => {
    const SAMPLE_RATE = 24000;
    const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
    const END_TIMEOUT_MS = 3000;       // wait this long for session.ended before force-closing
    const START_BUFFER_S = 0.3;        // audio buffered before a reply starts; later chunks play without waiting
    const ECHO_VAD_STEP = 1.3;         // each echo false-trigger raises the local detector threshold by this factor…
    const ECHO_VAD_MAX = 0.12;         // …up to this
    const PROBE_MS = 600;              // paused this long: mic still hearing speech → user, went quiet → echo
    const RELEASE_GRACE_MS = 800;      // after the user stops, wait this long for the server before resuming

    const params = new URLSearchParams(location.search);
    const DEBUG = params.has('debug');
    const SPEECH_RMS = Number(params.get('vad')) || 0.03;  // local detector level; tune with ?vad=
    let speechRms = SPEECH_RMS;        // per session; raised automatically when echo trips the detector
    const DEBUG_LINES = 15;
    function log(msg, data) {
        if (!DEBUG) return;
        console.log('[voice]', msg, data || '');
        const panel = document.getElementById('voice-debug');
        if (!panel) return;
        const line = document.createElement('div');
        line.textContent = `${(performance.now() / 1000).toFixed(1)}s ${msg} ${data ? JSON.stringify(data) : ''}`;
        panel.appendChild(line);
        while (panel.childElementCount > DEBUG_LINES) panel.firstElementChild.remove();
    }

    const SYSTEM_PROMPT = `You are the voice shopping assistant for VoiceCart, an online umbrella store.
You are talking out loud, so never use markdown, lists, emojis or symbols. Keep replies short, usually one or two sentences. When walking through search results you may use up to five short sentences.
Round prices when speaking, for example "about thirty dollars".
Be warm, friendly and humble, like a helpful friend in the store. If you get something wrong, apologise briefly and correct yourself.
Whenever the user describes what they want or changes a requirement, call search_products. It updates the products on the user's screen. Each call replaces the previous filters, so include every requirement the user still wants.
Only talk about products, prices, specs and ratings that a tool returned. Never invent them. If you do not know something, say so.
After a search, say how many umbrellas matched, then walk through the top three by position, one short sentence each with its best point and its main drawback from the tool results, then ask which one interests them. Introduce each one by position and brand, for example "The first one, the TUMELLA, …".
Results are numbered by position, so "the second one" means position two of the latest search. When the user refers to a result by its number or order, pass its position from the latest search; never guess an id. Positions from earlier searches no longer apply.
When the user asks for more about a product or what people say, call show_product. When they want to compare or choose, call compare_products with two or three ids.
Use update_cart to add, remove or change quantities. When the user wants to pay, call checkout, read the total, and ask them to confirm. Only call place_order with user_confirmed true after they clearly say yes. If they say no, do not place it.
If nothing matches, say so and offer to relax one requirement, such as the price.`;

    const GREETING = "Hi, I'm your VoiceCart shopping assistant. What kind of umbrella are you looking for today?";

    // Measured with scripts/voice_latency.py: max_silence 4000 → 2000 cuts time to first audio by ~2.5 s;
    // lower values make reply audio arrive with multi-second gaps.
    const TURN_DETECTION = { vad_threshold: 0.5, min_silence: 1000, max_silence: 2000, interrupt_response: true };
    if (params.has('svad')) TURN_DETECTION.vad_threshold = Number(params.get('svad'));
    // Server-side barge-in delay (0–1000 ms); only sent when set with ?idelay= while tuning.
    if (params.has('idelay')) TURN_DETECTION.interruption_delay = Number(params.get('idelay'));

    const STATUS_TEXT = {
        idle: 'Tap to shop by voice',
        connecting: 'Connecting…',
        listening: 'Listening…',
        speaking: 'Speaking — just talk to interrupt',
    };

    let ws = null;
    let audioCtx = null;               // mic capture, native sample rate
    let playCtx = null;                // agent audio at 24 kHz; suspended to pause the agent instantly
    let playNode = null;               // playback worklet in playCtx
    let micStream = null;
    let micSource = null;
    let micNode = null;
    let sessionReady = false;
    let status = 'idle';
    // Bumped on every start/stop; async work from an older attempt checks it and bails out.
    let attempt = 0;

    // Agent audio playback, as reported by the playback worklet
    let agentAudio = false;            // audio queued or playing
    let agentPlaying = false;          // audible right now (not buffering)
    let segCounter = 0;                // every reply and acknowledgement clip is its own segment
    let replySeg = 0;
    // False after the server reports a reply as interrupted, until the next reply starts, so any
    // late chunks of the interrupted reply are dropped.
    let acceptAudio = true;

    // Acknowledgement clips per tool ({ text, samples }), loaded from audio/acks.json
    const acks = {};
    const ackNext = {};
    let ackThisTurn = false;           // at most one acknowledgement per user turn

    // Barge-in hold: 'none' → 'probing' (paused, deciding user vs echo) → 'user' (paused, waiting for the server)
    let hold = 'none';
    let userSpeaking = false;          // local detector: between 'speech' and 'silence'
    let heldAt = 0;
    let heardUser = false;             // the server transcribed the user since the hold began
    let probeTimer = null;
    let releaseTimer = null;

    // Debug counters for the current reply
    let replyStartedAt = 0;
    let droppedChunks = 0;

    // Live agent caption, built from word deltas
    let agentText = '';

    // Card highlights timed to the agent's speech: each product mention in agentText is fired when the
    // reply's playback reaches its estimated time (character offset ÷ speaking rate).
    let charsPerSec = 14;              // speaking rate, refined after every reply
    let replyAudioS = 0;               // seconds of audio received for the current reply
    let pendingHighlights = [];        // { id, atS }
    let seenMentions = new Set();      // character offsets already scheduled in this reply

    // Tool results may only be sent once the current turn is over (reply.done). Results from a
    // reply the user interrupted are thrown away; turnGen marks which results are still valid.
    let turnActive = false;
    let turnGen = 0;
    let pendingResults = [];

    const $ = sel => document.querySelector(sel);

    /* ── UI ─────────────────────────────────────────────────────── */
    function setStatus(next, message) {
        status = next;
        const dock = $('#voice-dock');
        dock.dataset.status = next;
        $('#voice-status').textContent = message || STATUS_TEXT[next] || '';
        const active = next !== 'idle' && next !== 'error';
        const btn = $('#voice-btn');
        btn.setAttribute('aria-pressed', String(active));
        btn.setAttribute('aria-label', active ? 'Stop voice shopping' : 'Start voice shopping');
    }

    function showUser(text) { $('#voice-user').textContent = text; }
    function showAgent(text) { $('#voice-agent').textContent = text; }

    /* ── BASE64 ─────────────────────────────────────────────────── */
    function bytesToBase64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
    }

    function base64ToBytes(b64) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    /* ── SOCKET ─────────────────────────────────────────────────── */
    function send(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function openSocket(token) {
        const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
        ws = socket;

        socket.onopen = () => {
            send({
                type: 'session.update',
                session: {
                    system_prompt: SYSTEM_PROMPT,
                    greeting: GREETING,
                    tools: AgentTools.definitions(),
                    input: {
                        keyterms: AgentTools.keyterms(),
                        turn_detection: TURN_DETECTION,
                    },
                },
            });
        };

        socket.onmessage = e => {
            let evt;
            try { evt = JSON.parse(e.data); } catch (_) { return; }
            if (socket !== ws) {
                // A session we already stopped: only wait for its clean end.
                if (evt.type === 'session.ended') socket.close();
                return;
            }
            handleEvent(evt);
        };

        socket.onclose = e => {
            if (socket !== ws) return;  // closed on purpose by stop()
            console.warn('Voice socket closed', e.code, e.reason);
            teardown();
            setStatus('error', e.code === 1008
                ? 'Voice session was rejected (token invalid or expired).'
                : 'Voice connection closed.');
        };
    }

    function handleEvent(evt) {
        switch (evt.type) {
            case 'session.ready':
                sessionReady = true;
                startMic();
                setStatus('listening');
                break;

            case 'input.speech.started':
                // Pause the agent; the reply is only discarded once the server reports it interrupted.
                turnActive = true;
                log('server speech.started', {
                    msIntoReply: sinceReply(),
                    audioQueued: agentAudio,
                    msAfterLocalPause: heldAt ? Math.round(performance.now() - heldAt) : null,
                });
                if (agentAudio) pause('user');
                else if (hold === 'probing') hold = 'user';
                clearTimeout(probeTimer);
                clearTimeout(releaseTimer);
                showUser('…');
                break;

            case 'input.speech.stopped':
                if (hold !== 'none' && !userSpeaking) releaseAfterGrace();
                break;

            case 'transcript.user.delta':
            case 'transcript.user':
                heardUser = true;
                if (evt.type === 'transcript.user') ackThisTurn = false;  // a new user turn
                if (evt.text) showUser(evt.text);
                break;

            case 'reply.started':
                // A new reply while the agent is paused for the user: the held audio is an old answer.
                if (hold !== 'none') discardHeld('new reply started');
                turnActive = true;
                acceptAudio = true;
                agentText = '';
                resetHighlights();
                replyAudioS = 0;
                replySeg = ++segCounter;
                replyStartedAt = performance.now();
                droppedChunks = 0;
                break;

            case 'reply.audio':
                if (acceptAudio) playChunk(evt.data);
                else droppedChunks++;
                break;

            case 'transcript.agent.delta':
                if (evt.delta) {
                    // Deltas are words; some carry their own spacing, so only add a space when neither side has one.
                    const needsSpace = agentText && !/\s$/.test(agentText) && !/^\s/.test(evt.delta);
                    agentText += (needsSpace ? ' ' : '') + evt.delta;
                    showAgent(agentText);
                    scheduleMentions();
                }
                break;

            case 'transcript.agent':
                showAgent(evt.text);
                break;

            case 'reply.done':
                turnActive = false;
                log('reply.done', { status: evt.status, msIntoReply: sinceReply(), droppedChunks, hold });
                if (playNode) playNode.port.postMessage({ type: 'end', seg: replySeg });
                if (evt.status === 'interrupted') {
                    discardHeld('server interrupted the reply');
                    resetHighlights();
                    acceptAudio = false;
                    pendingResults = [];
                    turnGen++;  // results of tools still running for this reply are stale
                } else {
                    learnSpeakingRate();
                    flushResults();
                }
                break;

            case 'tool.call':
                playAck(evt.name);
                runTool(evt);
                break;

            case 'session.error':
                console.error('Voice session error', evt);
                UI.toast(`Voice error: ${evt.message || evt.code}`);
                break;

            case 'session.ended': {
                // Ended by the server (e.g. max session length reached).
                const socket = ws;
                teardown();
                setStatus('idle', 'Voice session ended. Tap to start again.');
                socket.close();
                break;
            }
        }
    }

    /* ── TOOLS ──────────────────────────────────────────────────── */
    async function runTool(evt) {
        const gen = turnGen;
        let result;
        let isError = false;
        try {
            result = await AgentTools.run(evt.name, evt.arguments);
        } catch (err) {
            console.warn('Tool failed', evt.name, evt.arguments, err);
            result = { error: err.message };
            isError = true;
        }
        log(`tool ${evt.name}`, { args: evt.arguments, result: toolSummary(result) });
        if (gen !== turnGen) return;  // interrupted, or the session ended, while the tool ran
        const msg = { type: 'tool.result', call_id: evt.call_id, result: JSON.stringify(result) };
        if (isError) msg.is_error = true;
        pendingResults.push(msg);
        flushResults();  // the tool may finish after reply.done has already arrived
    }

    /* Short form of a tool result for the debug log */
    function toolSummary(r) {
        if (!r || typeof r !== 'object') return r;
        if (r.error) return { error: r.error };
        if (r.results) return { matches: r.total_matches, query: r.query_used, ids: r.results.map(x => x.id) };
        if (r.products) return { ids: r.products.map(x => x.id) };
        if (r.id) return { id: r.id, position: r.position };
        if (r.items) return { items: r.items.map(i => `${i.id}×${i.quantity}`), total: r.total };
        return r;
    }

    function flushResults() {
        if (turnActive) return;
        pendingResults.splice(0).forEach(send);
    }

    /* ── MIC ────────────────────────────────────────────────────── */
    function startMic() {
        micSource = audioCtx.createMediaStreamSource(micStream);
        // numberOfOutputs: 0 → the node is always processed without being wired to the speakers.
        micNode = new AudioWorkletNode(audioCtx, 'mic-processor', {
            numberOfOutputs: 0,
            processorOptions: { speechRms },
        });
        micNode.port.onmessage = e => {
            if (e.data === 'speech') { onLocalSpeech(); return; }
            if (e.data === 'silence') { onLocalSilence(); return; }
            if (!sessionReady) return;
            send({ type: 'input.audio', audio: bytesToBase64(new Uint8Array(e.data)) });
        };
        micSource.connect(micNode);
    }

    /* ── PLAYBACK ───────────────────────────────────────────────── */
    function playChunk(b64) {
        if (!playNode || !b64) return;
        const bytes = base64ToBytes(b64);
        const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
        if (!pcm.length) return;
        const samples = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
        replyAudioS += samples.length / SAMPLE_RATE;
        pushAudio(replySeg, samples);
    }

    function pushAudio(seg, samples) {
        playNode.port.postMessage({ type: 'push', seg, samples }, [samples.buffer]);
        agentAudio = true;
    }

    function onPlaybackMessage(e) {
        const m = e.data;
        if (m.type === 'playing') {
            agentPlaying = true;
            if (status === 'listening' && hold === 'none') setStatus('speaking');
        } else if (m.type === 'idle') {
            agentPlaying = false;
            agentAudio = false;
            if (status === 'speaking') setStatus('listening');
            // The reply has played to the end: any mention whose time was overestimated is due now.
            if (!turnActive && replyAudioS > 0) fireHighlights(replySeg, Infinity);
        } else if (m.type === 'underrun') {
            log('underrun: paused mid-reply to rebuffer', { needMs: m.needMs, msIntoReply: sinceReply() });
        } else if (m.type === 'progress') {
            fireHighlights(m.seg, m.playedS);
        }
    }

    /* ── CARD HIGHLIGHTS ────────────────────────────────────────── */
    const ORDINALS = { first: 1, second: 2, third: 3, one: 1, two: 2, three: 3 };
    // Only explicit references count: "the first one", "number two", "the last one"; not "at first".
    const POSITION_PATTERNS = [
        [/\b(first|second|third)\s+(?:one|option|pick|umbrella)\b/gi, m => ORDINALS[m[1].toLowerCase()]],
        [/\b(?:number|option)\s+(one|two|three)\b/gi, m => ORDINALS[m[1].toLowerCase()]],
        [/\bthe\s+last\s+one\b/gi, () => 'last'],
    ];

    /* Product mentions in text, as [{ id, offset }] sorted by offset. candidates: the numbered cards,
       [{ id, pos, brand }]. A brand counts only when one numbered card has it. */
    function findMentions(text, candidates) {
        const idAt = new Map(candidates.map(c => [c.pos, c.id]));
        const lastPos = Math.max(0, ...candidates.map(c => c.pos));
        const found = [];
        for (const [re, position] of POSITION_PATTERNS) {
            for (const m of text.matchAll(re)) {
                const p = position(m);
                const id = idAt.get(p === 'last' ? lastPos : p);
                if (id !== undefined) found.push({ id, offset: m.index });
            }
        }
        const brandCount = {};
        for (const c of candidates) brandCount[c.brand.toLowerCase()] = (brandCount[c.brand.toLowerCase()] || 0) + 1;
        for (const c of candidates) {
            if (brandCount[c.brand.toLowerCase()] !== 1) continue;
            const escaped = c.brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            for (const m of text.matchAll(new RegExp(`\\b${escaped}\\b`, 'gi'))) found.push({ id: c.id, offset: m.index });
        }
        return found.sort((a, b) => a.offset - b.offset);
    }

    /* The cards search_products numbered 1–3 (UI.markPositions) */
    function numberedCards() {
        return [...document.querySelectorAll('.product-card')].flatMap(card => {
            const tag = card.querySelector('.card-position');
            const brand = card.querySelector('.card-brand-badge');
            return tag && brand ? [{ id: card.dataset.id, pos: Number(tag.textContent), brand: brand.textContent.trim() }] : [];
        });
    }

    function scheduleMentions() {
        const cards = numberedCards();
        if (!cards.length) return;
        for (const m of findMentions(agentText, cards)) {
            if (seenMentions.has(m.offset)) continue;
            seenMentions.add(m.offset);
            pendingHighlights.push({ id: m.id, atS: m.offset / charsPerSec });
        }
    }

    function fireHighlights(seg, playedS) {
        if (seg !== replySeg || !pendingHighlights.length) return;
        const due = pendingHighlights.filter(h => h.atS <= playedS);
        if (!due.length) return;
        pendingHighlights = pendingHighlights.filter(h => h.atS > playedS);
        const latest = due.reduce((a, b) => (b.atS >= a.atS ? b : a));
        UI.highlightCard(latest.id);
        log('highlight card', { id: latest.id, atS: Number(latest.atS.toFixed(2)), playedS: Number(Math.min(playedS, 999).toFixed(2)) });
    }

    function resetHighlights() {
        pendingHighlights = [];
        seenMentions = new Set();
    }

    /* Characters per second of reply audio, averaged over the session */
    function learnSpeakingRate() {
        if (replyAudioS < 1 || !agentText) return;
        const rate = agentText.length / replyAudioS;
        charsPerSec = Math.min(25, Math.max(8, 0.7 * charsPerSec + 0.3 * rate));
        log('speaking rate', { charsPerSec: Number(charsPerSec.toFixed(1)) });
    }

    function stopPlayback() {
        if (playNode) playNode.port.postMessage({ type: 'clear' });
        agentAudio = false;
        agentPlaying = false;
        if (status === 'speaking') setStatus('listening');
    }

    /* ── ACKNOWLEDGEMENTS ───────────────────────────────────────── */
    async function loadAcks() {
        try {
            const manifest = await (await fetch('audio/acks.json')).json();
            for (const [tool, lines] of Object.entries(manifest)) {
                acks[tool] = await Promise.all(lines.map(async ({ file, text }) => {
                    const pcm = new Int16Array(await (await fetch(file)).arrayBuffer());
                    const samples = new Float32Array(pcm.length);
                    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
                    return { text, samples };
                }));
                ackNext[tool] = 0;
            }
        } catch (err) {
            console.warn('Acknowledgement clips not loaded', err);  // the agent still works without them
        }
    }

    /* The model is working on a tool; say something now instead of leaving silence. */
    function playAck(tool) {
        const lines = acks[tool];
        if (!playNode || !lines || !lines.length || ackThisTurn || agentAudio || hold !== 'none') return;
        const line = lines[ackNext[tool]++ % lines.length];
        const seg = ++segCounter;
        pushAudio(seg, line.samples.slice());  // slice: the transfer detaches the buffer
        playNode.port.postMessage({ type: 'end', seg });
        ackThisTurn = true;
        showAgent(line.text);
        log('acknowledgement', { tool, text: line.text, msIntoReply: sinceReply() });
    }

    /* ── BARGE-IN HOLD ──────────────────────────────────────────── */
    function onLocalSpeech() {
        userSpeaking = true;
        clearTimeout(releaseTimer);
        if (hold !== 'none' || !agentAudio) return;
        // Pause first, decide later: silence also stops the echo canceller from suppressing the user's voice.
        pause('probing');
        probeTimer = setTimeout(() => {
            if (hold === 'probing' && userSpeaking) {
                hold = 'user';
                log('user still talking → keep paused, wait for the server');
            }
        }, PROBE_MS);
    }

    function onLocalSilence() {
        userSpeaking = false;
        if (hold === 'probing') {
            // The "speech" stopped as soon as the agent went quiet: it was the agent's own echo.
            clearTimeout(probeTimer);
            resume('went quiet while paused → echo');
            // Echo got through: make the local detector less sensitive for the rest of the session.
            speechRms = Math.min(ECHO_VAD_MAX, speechRms * ECHO_VAD_STEP);
            if (micNode) micNode.port.postMessage({ threshold: speechRms });
            log('raised local detector threshold', { vad: Number(speechRms.toFixed(3)) });
        } else if (hold === 'user') {
            releaseAfterGrace();
        }
    }

    function pause(kind) {
        if (hold === 'none') {
            heldAt = performance.now();
            heardUser = false;
            if (playCtx) playCtx.suspend().catch(() => {});
            log('pause agent', { reason: kind === 'probing' ? 'local speech' : 'server speech', msIntoReply: sinceReply() });
            if (status === 'speaking') setStatus('listening');
        }
        hold = kind;
    }

    function resume(reason) {
        if (hold === 'none') return;
        clearTimeout(probeTimer);
        clearTimeout(releaseTimer);
        hold = 'none';
        log(`resume: ${reason}`, { msPaused: Math.round(performance.now() - heldAt) });
        heldAt = 0;
        if (playCtx) playCtx.resume().catch(() => {});
        if (agentPlaying) setStatus('speaking');
    }

    function discardHeld(reason) {
        if (hold === 'none' && !agentAudio) return;
        log(`discard queued audio: ${reason}`);
        stopPlayback();
        resetHighlights();  // the discarded words will never be heard
        resume(reason);
    }

    /* The user has stopped; if the server has not interrupted by then, it did not treat this as a barge-in. */
    function releaseAfterGrace() {
        clearTimeout(releaseTimer);
        releaseTimer = setTimeout(() => {
            if (hold === 'none') return;
            const missed = !heardUser;
            resume('user stopped, the server kept the reply → continue');
            if (missed && status !== 'idle') setStatus(status, 'Sorry, I missed that. Please say it again.');
        }, RELEASE_GRACE_MS);
    }

    function sinceReply() {
        return replyStartedAt ? Math.round(performance.now() - replyStartedAt) : null;
    }

    /* ── LIFECYCLE ──────────────────────────────────────────────── */
    function friendlyError(err) {
        if (err && err.name === 'NotAllowedError') return 'Microphone permission was denied.';
        if (err && err.name === 'NotFoundError') return 'No microphone found.';
        return (err && err.message) || 'Could not start voice.';
    }

    async function start() {
        if (status !== 'idle' && status !== 'error') return;
        const myAttempt = ++attempt;
        const stale = () => myAttempt !== attempt;  // user pressed stop (or restarted) meanwhile
        setStatus('connecting');
        showUser('');
        showAgent('');
        acceptAudio = true;
        speechRms = SPEECH_RMS;
        ackThisTurn = false;
        try {
            // Created inside the click gesture so they are allowed to run. The mic context uses the native
            // rate (the worklet resamples to 24 kHz; Firefox rejects mic sources at other rates). Agent
            // audio gets its own 24 kHz context so it can be paused without stopping the mic.
            audioCtx = new AudioContext();
            playCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
            await Promise.all([audioCtx.resume(), playCtx.resume()]);
            await playCtx.audioWorklet.addModule('js/playback_worklet.js');
            if (stale()) return;
            playNode = new AudioWorkletNode(playCtx, 'playback-processor', {
                numberOfInputs: 0,
                outputChannelCount: [1],
                processorOptions: { startS: START_BUFFER_S },
            });
            playNode.port.onmessage = onPlaybackMessage;
            playNode.connect(playCtx.destination);
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true },
            });
            if (stale()) { stream.getTracks().forEach(t => t.stop()); return; }
            micStream = stream;
            await audioCtx.audioWorklet.addModule('js/mic_worklet.js');
            if (stale()) return;

            // Tokens are single-use and short-lived: mint right before connecting.
            const res = await fetch('/api/token', { cache: 'no-store' });
            const body = await res.json().catch(() => ({}));
            if (stale()) return;
            if (!res.ok || !body.token) throw new Error(body.error || `Token request failed (${res.status})`);

            openSocket(body.token);
        } catch (err) {
            if (stale()) return;
            console.error('Voice start failed', err);
            teardown();
            setStatus('error', friendlyError(err));
        }
    }

    function stop() {
        if (status === 'idle') return;
        attempt++;
        const socket = ws;
        const wasReady = sessionReady;
        teardown();  // detaches `socket`: its late events and close are ignored from now on
        setStatus('idle');
        if (!socket) return;
        if (socket.readyState === WebSocket.OPEN && wasReady) {
            // End cleanly so we don't pay for the 30 s resume window; the socket closes itself
            // on session.ended, or after a timeout if that never arrives.
            socket.send(JSON.stringify({ type: 'session.end' }));
            setTimeout(() => socket.close(), END_TIMEOUT_MS);
        } else {
            socket.close();
        }
    }

    function stopMic() {
        if (micNode) { micNode.port.onmessage = null; micNode.disconnect(); micNode = null; }
        if (micSource) { micSource.disconnect(); micSource = null; }
        if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    }

    function teardown() {
        stopMic();
        stopPlayback();
        clearTimeout(probeTimer);
        clearTimeout(releaseTimer);
        hold = 'none';
        heldAt = 0;
        userSpeaking = false;
        if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
        if (playNode) { playNode.port.onmessage = null; playNode.disconnect(); playNode = null; }
        if (playCtx) { playCtx.close().catch(() => {}); playCtx = null; }
        sessionReady = false;
        turnActive = false;
        pendingResults = [];
        turnGen++;
        resetHighlights();
        ws = null;
    }

    function toggle() {
        if (status === 'idle' || status === 'error') start();
        else stop();
    }

    function init() {
        $('#voice-btn').addEventListener('click', toggle);
        if (DEBUG) {
            const panel = document.createElement('div');
            panel.id = 'voice-debug';
            panel.className = 'voice-debug';
            document.body.appendChild(panel);
            log('debug on', { localVad: SPEECH_RMS, turnDetection: TURN_DETECTION });
        }
        loadAcks();
        $('#hero-voice-btn').addEventListener('click', start);
        window.addEventListener('pagehide', () => {
            if (ws && ws.readyState === WebSocket.OPEN) send({ type: 'session.end' });
        });
        setStatus('idle');
    }

    document.addEventListener('DOMContentLoaded', init);

    return { start, stop, findMentions };  // findMentions is exposed for scripts/test_mentions.js
})();
