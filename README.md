# VoiceCart AI
*Next-gen Voice-Driven E-Commerce MVP, powered by AssemblyAI Streaming STT.*

## Problem & Solution
Traditional GUI search in e-commerce can be clunky, especially on mobile devices or when users have specific, multi-attribute queries (e.g., "Show me windproof umbrellas under $45"). 
VoiceCart AI provides a real-time, voice-native shopping experience. By embedding an intelligent voice agent directly into the shopping UI, users can search, compare, and check out hands-free.

## AssemblyAI Key Highlights
- **Real-time Streaming STT:** Utilizes AssemblyAI's low-latency WebSockets API to process user intent instantly.
- **Barge-in Support:** The agent's local speech output is immediately interrupted when the user starts speaking, ensuring a natural conversational flow.

## How the voice pipeline handles interruptions and playback

The browser talks to AssemblyAI's Voice Agent API directly over a WebSocket. Our server only mints a single-use token, so the API key never reaches the browser. Mic audio goes up as 24 kHz PCM16, and the agent's reply comes back as 24 kHz PCM16 chunks that we schedule with the Web Audio API. Getting this to feel like a real conversation took the work below.

### 1. Smooth playback: a continuous playback worklet
Reply audio arrives as ~10 ms chunks, in bursts, and at times slower than real time (we measured 0.8×). Our first version scheduled one Web Audio source node per chunk, about 100 a second. Every late chunk left the schedule empty for a moment, so one slow stretch turned into many micro-gaps, which is stutter.

Playback now runs in an `AudioWorklet` (`frontend/js/playback_worklet.js`) with one continuous queue at 24 kHz:

- Each reply starts once **300 ms** is buffered. While audio keeps up, chunks play back to back with no extra delay.
- **Rebuffer on underrun.** If a reply is about to run dry mid-reply, playback fades out over about 5 ms, waits until **500 ms** is buffered, and fades back in. Each underrun adds 200 ms to the start and rebuffer waits, up to 1 s, for the rest of the session.
- Each reply and each acknowledgement clip is a separate segment, so a short clip or the last part of a reply plays at once.

A single queue removes the per-node scheduling gaps, but it can't make a slow source fast. We tried playing each chunk the instant it arrived after an underrun. On a slow reply the queue then alternates between one chunk and silence, which is stutter.

To compare playback versions, `python -m scripts.voice_latency capture` saves real replies with their chunk arrival times. `node scripts/replay_playback.js` then plays them through any version of the worklet offline. It prints the gaps and writes WAVs to listen to. Results on 12 captured replies (2.8–6.4 s each), delivered at 0.8× real time:

| Playback | Gaps per reply | Clicks |
|---|---|---|
| Play each chunk the instant it arrives | 17–52 | yes |
| Rebuffer with fades (current) | 2–3 | none |

At 1.0× delivery the current version has no gaps. On 26 Sep 2026 we measured AssemblyAI delivering at only 0.2–0.7× for every voice, with or without our prompt and tools. At that speed some pauses are unavoidable without a multi-second start delay.

### 2. Instant barge-in: pause, then let the server decide
AssemblyAI decides when the user has started speaking (`input.speech.started`) and whether the current reply is interrupted (`reply.done` with `status: "interrupted"`). Our measurements show that while the agent is talking, that decision can arrive more than a second after the user starts, sometimes only as they finish. While the agent plays, the browser's echo canceller also turns down the user's voice (double-talk suppression). So we handle the first moments locally and leave the final decision to the server:

1. **Pause.** Agent audio plays in its own 24 kHz `AudioContext`, and the mic runs in another one. A small energy detector in the mic `AudioWorklet` posts `speech` when the level stays above a threshold for 60 ms, and the page suspends the playback context. The agent stops mid-word. Nothing is thrown away: incoming chunks keep queuing behind the paused point. The silence also stops the echo canceller from suppressing the user, so the server hears them clearly.
2. **Echo check (600 ms).** Echo exists only while the agent is audible. If the mic goes quiet while the agent is paused, the sound was the agent's own voice, and playback resumes exactly where it stopped. No words are lost.
3. **Wait for the server.** If the user keeps talking, the agent stays paused:
   - If the server reports the reply as interrupted, or starts a new reply, the queued audio is discarded and the new answer plays.
   - If the server doesn't interrupt within 0.8 s of the user going quiet, it kept the reply going, so playback resumes. When the server also never transcribed the user, the dock asks them to repeat.

Audio is discarded only when the server says the reply was interrupted. Before this rule, a pause-and-continue sentence such as "show me red umbrellas … also yellow ones" could leave a reply showing as text with no sound.

### 3. Instant acknowledgement in the agent's own voice
A product search needs the model to decide to call a tool, our tool to run, and then the model to speak the result. That leaves seconds of silence. The moment a `tool.call` arrives, the page plays a short line such as "Sure, let me look." or "Let me find the best options for you." The line matches the tool, and lines rotate so it doesn't repeat.

- The clips are recorded from the Voice Agent API itself, so they are in the same voice as the live agent. `scripts/record_fillers.py` asks the agent to say each line, checks the transcript matches, trims the silence and saves `frontend/audio/ack_*.pcm`.
- A clip plays at most once per user turn, and only when the agent is otherwise silent. It goes through the same playback queue, so barge-in pauses and discards it like any other agent audio. The real answer queues straight behind it.
- Measured on searches, the user hears the acknowledgement **3.5 s** after they stop talking. The model's own first audio came at 4.6–6.4 s across our runs (section 6).

### 4. Echo safety: layered defence
On laptop speakers the agent's voice can leak into the mic. Four layers keep the agent from interrupting itself:

1. Browser echo cancellation (`echoCancellation: true`) removes the page's own output from the mic signal. Noise suppression stays off, as AssemblyAI recommends, because the server denoises.
2. The pause-and-check step in section 2 catches echo that gets through. A false trigger costs a pause of about half a second, and no audio is lost. Each false trigger also raises the local detector's threshold by 30% for the rest of the session, up to 0.12, so persistent echo stops tripping it.
3. AssemblyAI's server-side VAD (`vad_threshold`) decides whether a sound is speech before it interrupts.
4. Headphones remove echo entirely. The demo video is recorded with a headset.

### 5. Tool results that respect the conversation
Tools run in the browser and update the page, for example filtering the product grid. Their results go back to the agent only after `reply.done`, as the API requires. If the user interrupted that reply, the results are thrown away so the agent never answers a question the user has moved past.

### 6. Latency budget (measured, not guessed)
`scripts/voice_latency.py` streams recorded speech (`scripts/audio/*.wav`) to the Voice Agent API in real time, with the same prompt, tools and keyterms as the page. It answers tool calls the way the page does and times every event and audio chunk. Findings, as medians over 4 runs from our development machine:

| turn_detection `min_silence` / `max_silence` (ms) | first audio after "how are you?" | first audio after a product search | pre-buffer needed for gap-free audio (median / max) |
|---|---|---|---|
| 1400 / 4000 (first setting) | 5.7 s | 5.0 s | 80 / 255 ms |
| **1000 / 2000 (current)** | **3.3 s** | **4.6 s** | 137 / 459 ms |
| 800 / 1500 | 2.9 s | 4.4 s | 1650 / 4909 ms |
| 600 / 1200 | 3.0 s | 4.2 s | 2743 / 5441 ms |

- `max_silence` dominates. The server holds its answer until it's sure the user has finished, so 4000 → 2000 saves about 2.5 s on conversational replies.
- Going lower barely speeds up the first word, but the reply audio then arrives with multi-second gaps, which our buffer can't hide. 1000 / 2000 is the lowest setting that stays smooth.
- A product search costs a tool round trip: the model decides to call the tool (~1 s), our tool answers in ~0.2 s, and the model speaks the result. Asking the agent to say "let me look" first didn't make audio arrive sooner, so the page plays a recorded acknowledgement on `tool.call` instead (section 3).
- The pre-buffer column shows how uneven delivery is: usually under 0.5 s, but some replies stall for several seconds mid-stream. No fixed buffer hides that without making every reply slow (section 1).

Reproduce with `python -m scripts.voice_latency latency --trials 4 --silence 1400:4000 1000:2000`. `python -m scripts.voice_latency split` replays the "red umbrellas … also yellow ones" case and prints the full event sequence.

### Tuning and diagnostics
Add these to the URL to tune the pipeline without redeploying:

| Parameter | Effect |
|---|---|
| `?debug=1` | Shows an on-screen log (top left) and writes `[voice]` lines to the console: underruns, acknowledgements, local pauses and echo checks, server speech events with the delay after the local pause, discarded audio, and reply status. |
| `&vad=0.03` | Local detector threshold (mic RMS, 0–1). Raise it if the agent's own voice causes pauses, and lower it if your voice doesn't. |
| `&svad=0.5` | Overrides AssemblyAI's `vad_threshold` (0–1). |
| `&idelay=0` | Sends `interruption_delay` (0–1000 ms) to AssemblyAI's turn detection. |

## Supported Voice Commands
| Command Trigger | Description |
|-----------------|-------------|
| `search` | "Show me blue umbrellas" - Queries products by attributes. |
| `compare` | "Compare the StormShield and Aeroflex" - Triggers a 3-item comparison matrix. |
| `show item` / `inspect` | "Show item 1" - Deep dives into product specs and reviews. |
| `add to cart` | "Add this to my cart" - Adds the currently viewed item to the cart. |
| `checkout` | "Let's check out" - Navigates to the checkout flow. |
| `interrupt` | Any user speech instantly stops the agent from talking. |

## Quickstart Guide

1. **Clone & Setup Environment**
   ```bash
   cd voicecart-ai
   python -m venv venv
   source venv/bin/activate  # or venv\Scripts\activate on Windows
   pip install -e .
   ```

2. **Configure Environment**
   Copy `.env.example` to `.env` and add your AssemblyAI API Key:
   ```bash
   cp .env.example .env
   ```

3. **Run the Backend**
   ```bash
   uvicorn backend.main:app --reload
   ```

4. **Access the Frontend**
   Open `http://localhost:8000/` in your browser.
