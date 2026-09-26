/* =================================================================
   VoiceAgent — browser ↔ AssemblyAI Voice Agent API
   Mic → PCM16 24 kHz → input.audio; reply.audio → Web Audio playback.
   Barge-in ("mute and listen"): when the local detector hears speech, the
   agent is muted at once. Echo stops the moment our output stops, so if the
   mic goes quiet within PROBE_MS it was echo and playback resumes; if the
   user keeps talking, the rest of the reply is dropped and the agent stays
   silent until it answers. The server's input.speech.started also stops it.
   Add ?debug=1 to the URL for an on-screen log of audio timing.
   Docs: https://www.assemblyai.com/docs/voice-agents/voice-agent-api
   ================================================================= */

const VoiceAgent = (() => {
    const SAMPLE_RATE = 24000;
    const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
    const END_TIMEOUT_MS = 3000;       // wait this long for session.ended before force-closing
    const PLAYBACK_LEAD_S = 0.2;       // jitter buffer at the start of a reply and after an underrun
    const PLAYBACK_LEAD_STEP_S = 0.1;  // each underrun grows the buffer by this much…
    const PLAYBACK_LEAD_MAX_S = 0.5;   // …up to this, for the rest of the session
    const PROBE_MS = 600;              // muted this long: mic still hearing speech → user, went quiet → echo
    const MISSED_MS = 2500;            // after the user stops, wait this long for the server to react

    const params = new URLSearchParams(location.search);
    const DEBUG = params.has('debug');
    const SPEECH_RMS = Number(params.get('vad')) || 0.03;  // local detector level; tune with ?vad=
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
You are talking out loud, so never use markdown, lists, emojis or symbols. Keep replies to one or two short sentences.
Round prices when speaking, for example "about thirty dollars".
Be warm, friendly and humble, like a helpful friend in the store. If you get something wrong, apologise briefly and correct yourself.
Whenever the user describes what they want or changes a requirement, call search_products. It updates the products on the user's screen. Each call replaces the previous filters, so include every requirement the user still wants.
Only talk about products, prices, specs and ratings that a tool returned. Never invent them. If you do not know something, say so.
After a search, say how many umbrellas matched, mention the top one or two by brand with the detail that fits the request, and ask what matters most to them.
Results are numbered by position, so "the second one" means position two of the latest search.
If nothing matches, say so and offer to relax one requirement, such as the price.`;

    const GREETING = "Hi, I'm your VoiceCart shopping assistant. What kind of umbrella are you looking for today?";

    // Starting point from the docs; tune by ear.
    const TURN_DETECTION = { vad_threshold: 0.5, min_silence: 1400, max_silence: 4000, interrupt_response: true };
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
    let audioCtx = null;
    let micStream = null;
    let micSource = null;
    let micNode = null;
    let outGain = null;                // all agent audio goes through this, so it can be muted instantly
    let sessionReady = false;
    let status = 'idle';
    // Bumped on every start/stop; async work from an older attempt checks it and bails out.
    let attempt = 0;

    // Agent audio playback
    const playing = new Set();
    let nextStartTime = 0;
    // False from the moment the user barges in until the next reply starts, so audio chunks
    // of the interrupted reply that are still in flight are dropped instead of played.
    let acceptAudio = true;
    let leadS = PLAYBACK_LEAD_S;

    // Local barge-in state: 'none' → 'probing' (muted, deciding user vs echo) → 'committed' (reply dropped)
    let barge = 'none';
    let userSpeaking = false;          // local detector: between 'speech' and 'silence'
    let mutedAt = 0;
    let probeTimer = null;
    let missedTimer = null;

    // Debug counters for the current reply
    let replyStartedAt = 0;
    let droppedChunks = 0;

    // Live agent caption, built from word deltas
    let agentText = '';

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
                // Barge-in: cut the agent off the moment the user starts talking.
                turnActive = true;
                log('server speech.started', {
                    msIntoReply: sinceReply(),
                    audioPlaying: playing.size > 0,
                    msAfterLocalMute: mutedAt ? Math.round(performance.now() - mutedAt) : null,
                });
                resetBarge();
                acceptAudio = false;
                stopPlayback();
                showUser('…');
                break;

            case 'transcript.user.delta':
            case 'transcript.user':
                clearTimeout(missedTimer);
                if (evt.text) showUser(evt.text);
                break;

            case 'reply.started':
                turnActive = true;
                acceptAudio = true;
                agentText = '';
                nextStartTime = 0;  // a fresh reply gets the full jitter buffer
                replyStartedAt = performance.now();
                droppedChunks = 0;
                resetBarge();
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
                }
                break;

            case 'transcript.agent':
                showAgent(evt.text);
                break;

            case 'reply.done':
                turnActive = false;
                log('reply.done', { status: evt.status, msIntoReply: sinceReply(), droppedChunks });
                if (evt.status === 'completed' && droppedChunks) {
                    log('reply completed on the server, but its end was not played (barge-in)', { droppedChunks });
                }
                if (evt.status === 'interrupted') {
                    stopPlayback();
                    pendingResults = [];
                    turnGen++;  // results of tools still running for this reply are stale
                } else {
                    flushResults();
                }
                break;

            case 'tool.call':
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
        if (gen !== turnGen) return;  // interrupted, or the session ended, while the tool ran
        const msg = { type: 'tool.result', call_id: evt.call_id, result: JSON.stringify(result) };
        if (isError) msg.is_error = true;
        pendingResults.push(msg);
        flushResults();  // the tool may finish after reply.done has already arrived
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
            processorOptions: { speechRms: SPEECH_RMS },
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
        if (!audioCtx || !b64) return;
        const bytes = base64ToBytes(b64);
        const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
        if (!pcm.length) return;

        const buffer = audioCtx.createBuffer(1, pcm.length, SAMPLE_RATE);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(outGain);

        const now = audioCtx.currentTime;
        if (nextStartTime < now) {
            if (nextStartTime) {
                // Ran dry mid-reply: the network is jittery, so keep a bigger buffer from now on.
                leadS = Math.min(PLAYBACK_LEAD_MAX_S, leadS + PLAYBACK_LEAD_STEP_S);
                log('underrun', {
                    gapMs: Math.round((now - nextStartTime) * 1000),
                    msIntoReply: sinceReply(),
                    newBufferMs: Math.round(leadS * 1000),
                });
            }
            nextStartTime = now + leadS;
        }
        src.start(nextStartTime);
        nextStartTime += buffer.duration;

        playing.add(src);
        src.onended = () => {
            playing.delete(src);
            if (!playing.size && status === 'speaking') setStatus('listening');
        };
        if (status === 'listening') setStatus('speaking');
    }

    function stopPlayback() {
        for (const src of playing) {
            src.onended = null;
            try { src.stop(); } catch (_) { /* already stopped */ }
        }
        playing.clear();
        nextStartTime = 0;
        setGain(1);  // sources are gone; the next reply plays at full volume
        if (status === 'speaking') setStatus('listening');
    }

    /* ── LOCAL BARGE-IN ─────────────────────────────────────────── */
    function onLocalSpeech() {
        userSpeaking = true;
        clearTimeout(missedTimer);
        if (barge !== 'none' || !playing.size) return;
        // Mute first, decide later: silence also stops the echo canceller from suppressing the user's voice.
        barge = 'probing';
        mutedAt = performance.now();
        setGain(0);
        log('local speech → mute', { msIntoReply: sinceReply() });
        probeTimer = setTimeout(endProbe, PROBE_MS);
    }

    function onLocalSilence() {
        userSpeaking = false;
        if (barge === 'probing') {
            // The "speech" stopped as soon as the agent went quiet: it was the agent's own echo.
            clearTimeout(probeTimer);
            barge = 'none';
            setGain(1);
            log('went quiet while muted → echo, resume', { msMuted: Math.round(performance.now() - mutedAt) });
        } else if (barge === 'committed') {
            missedTimer = setTimeout(missedUser, MISSED_MS);
        }
    }

    function endProbe() {
        if (barge !== 'probing' || !userSpeaking) return;
        // Still talking with the agent silent: the user is interrupting. Drop the rest of this reply.
        barge = 'committed';
        acceptAudio = false;
        stopPlayback();
        log('user still talking → drop reply, wait for answer');
    }

    function missedUser() {
        // The server never reacted to what the user said; tell them instead of leaving dead air.
        log('no server reaction after user spoke → ask to repeat');
        barge = 'none';
        if (status === 'listening') setStatus('listening', 'Sorry, I missed that. Please say it again.');
    }

    function resetBarge() {
        clearTimeout(probeTimer);
        clearTimeout(missedTimer);
        barge = 'none';
        mutedAt = 0;
    }

    function setGain(value) {
        if (outGain) outGain.gain.setTargetAtTime(value, audioCtx.currentTime, 0.01);
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
        leadS = PLAYBACK_LEAD_S;
        try {
            // Created inside the click gesture so it is allowed to play sound. Native sample rate:
            // the mic worklet resamples to 24 kHz, and playback buffers are created at 24 kHz.
            audioCtx = new AudioContext();
            await audioCtx.resume();
            outGain = audioCtx.createGain();
            outGain.connect(audioCtx.destination);
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
        if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
        outGain = null;
        sessionReady = false;
        resetBarge();
        userSpeaking = false;
        turnActive = false;
        pendingResults = [];
        turnGen++;
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
        $('#hero-voice-btn').addEventListener('click', start);
        window.addEventListener('pagehide', () => {
            if (ws && ws.readyState === WebSocket.OPEN) send({ type: 'session.end' });
        });
        setStatus('idle');
    }

    document.addEventListener('DOMContentLoaded', init);

    return { start, stop };
})();
