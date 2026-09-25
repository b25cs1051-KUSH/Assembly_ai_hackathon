/* =================================================================
   VoiceAgent — browser ↔ AssemblyAI Voice Agent API
   Mic → PCM16 24 kHz → input.audio; reply.audio → Web Audio playback.
   Barge-in: user speech stops agent playback immediately.
   Docs: https://www.assemblyai.com/docs/voice-agents/voice-agent-api
   ================================================================= */

const VoiceAgent = (() => {
    const SAMPLE_RATE = 24000;
    const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
    const END_TIMEOUT_MS = 3000;       // wait this long for session.ended before force-closing
    const PLAYBACK_LEAD_S = 0.05;      // small jitter buffer before the first chunk of a reply

    const SYSTEM_PROMPT = `You are the voice shopping assistant for VoiceCart, an online umbrella store.
You are talking out loud, so never use markdown, lists, emojis or symbols. Keep replies to one or two short sentences.
Round prices when speaking, for example "about thirty dollars".
Be warm, friendly and humble, like a helpful friend in the store. If you get something wrong, apologise briefly and correct yourself.
Never invent products, prices, specs or reviews. You do not have access to the catalog yet, so if the user asks about specific products, say you cannot look them up right now.`;

    const GREETING = "Hi, I'm your VoiceCart shopping assistant. What kind of umbrella are you looking for today?";

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

    // Live agent caption, built from word deltas
    let agentText = '';

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
                acceptAudio = false;
                stopPlayback();
                showUser('…');
                break;

            case 'transcript.user.delta':
            case 'transcript.user':
                if (evt.text) showUser(evt.text);
                break;

            case 'reply.started':
                acceptAudio = true;
                agentText = '';
                break;

            case 'reply.audio':
                if (acceptAudio) playChunk(evt.data);
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
                if (evt.status === 'interrupted') stopPlayback();
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

    /* ── MIC ────────────────────────────────────────────────────── */
    function startMic() {
        micSource = audioCtx.createMediaStreamSource(micStream);
        // numberOfOutputs: 0 → the node is always processed without being wired to the speakers.
        micNode = new AudioWorkletNode(audioCtx, 'mic-processor', { numberOfOutputs: 0 });
        micNode.port.onmessage = e => {
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
        src.connect(audioCtx.destination);

        const now = audioCtx.currentTime;
        if (nextStartTime < now) nextStartTime = now + PLAYBACK_LEAD_S;
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
        if (status === 'speaking') setStatus('listening');
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
        try {
            // Created inside the click gesture so it is allowed to play sound. Native sample rate:
            // the mic worklet resamples to 24 kHz, and playback buffers are created at 24 kHz.
            audioCtx = new AudioContext();
            await audioCtx.resume();
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
        sessionReady = false;
        ws = null;
    }

    function toggle() {
        if (status === 'idle' || status === 'error') start();
        else stop();
    }

    function init() {
        $('#voice-btn').addEventListener('click', toggle);
        window.addEventListener('pagehide', () => {
            if (ws && ws.readyState === WebSocket.OPEN) send({ type: 'session.end' });
        });
        setStatus('idle');
    }

    document.addEventListener('DOMContentLoaded', init);

    return { start, stop };
})();
