# VoiceCart AI

**Talk to the store and it answers out loud while the page changes as you speak: search, compare, ask about reviews, fill the cart and check out without touching a button.**

**Live demo:** https://voicecart-ai-o76d.onrender.com/ (Chrome or Edge, allow the microphone; headphones give the cleanest barge-in)

Demo store: product photos are from public listings; prices, ratings and reviews are sample data.

## Try saying

Press the mic, then say these in order:

1. "I need a windproof umbrella under 30 dollars." The filters move, the grid updates and the top three results get numbers.
2. "Wait, which one is the lightest?" Say it while the agent is talking: it stops mid-sentence.
3. "Compare the first two." A side-by-side table opens.
4. "What do people complain about with the first one?" The agent answers only from the store's review data.
5. "Add it to my cart. Actually, make it two." The cart updates.
6. "Check out." The agent reads the total and asks you to confirm. Then say "Yes, place it."
7. Stop the mic, start it again and ask "What's in my cart?" It remembers the visit.

## AssemblyAI features used

| Feature | What it does in VoiceCart |
|---|---|
| Voice Agent API (one WebSocket) | Speech-to-text, the LLM, and text-to-speech in one session between the browser and AssemblyAI |
| Temporary tokens (`GET /v1/token`) | Our server mints a single-use token per session, so the API key never reaches the browser |
| Client-side tool calling | 7 JSON-Schema tools (`search_products`, `show_product`, `compare_products`, `update_compare`, `update_cart`, `checkout`, `place_order`) run in the browser and change the page. The agent only states prices, specs and reviews a tool returned |
| `input.keyterms` | Every brand name, so recognition spells "TUMELLA" or "SIEPASA" the way the catalog does |
| `input.turn_detection` | `min_silence 1000`, `max_silence 2000`, tuned by measurement (section 6 below) |
| Barge-in (`interrupt_response`, `input.speech.started`, `reply.done` interrupted) | The user can cut in at any time and the agent stops at once |
| `greeting` and `conversation.message` | A returning session gets "Welcome back" plus the earlier conversation, the results on screen and the cart |
| The agent's own voice | The acknowledgement clips ("Sure, let me look.") are recorded from the Voice Agent API, so they match the live voice |

How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run locally

Requires Python 3.10+ and an AssemblyAI API key.

```bash
python -m venv venv
venv\Scripts\activate            # Windows; on macOS or Linux: source venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env             # then set ASSEMBLYAI_API_KEY
uvicorn backend.main:app --port 8000
```

Open http://localhost:8000. Localhost counts as a secure context, so the microphone works without HTTPS.

## Tests

```bash
node scripts/test_agent_tools.js   # tools against the real catalog: spoken search wording, positions, compare, cart, checkout
node scripts/test_mentions.js      # product mentions in the agent's speech that time the card highlights
ruff check backend                 # lint
python -m scripts.voice_latency latency --trials 4 --silence 1000:2000   # live latency, needs the API key
```

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

#### Tuning pass (27 Sep 2026): three ideas, none kept
The script now answers tool calls with the page's own `agent_tools.js` (run in Node by `scripts/agent_tools_host.js`). It sends all 7 tool definitions and the exact results the page would send. Each variant was measured over 6 runs at 1000 / 2000, one change at a time. Medians of first agent audio after the user stops talking:

| Variant | "How are you?" | Product search | Search tool result | Kept |
|---|---|---|---|---|
| Baseline (current) | 3.40 s | 4.80 s | 1571 B | yes |
| `input.transcription_mode: "min_latency"` | 4.31 s | 8.23 s | 1571 B | no: slower, and in one run the reply started 0.27 s before the user finished, cutting them off |
| System prompt shortened from 3458 to 2729 characters, same rules | 5.14 s | 4.73 s | 1571 B | no: search within noise; two chit-chat runs had 7 s end-of-turn stalls on the server |
| Trimmed tool results (search: no drawback, no empty `other_colors`; `show_product`: 2 critical reviews, 1 top review) | 3.67 s | 4.75 s | 1282 B | no: within noise |

- Chit-chat calls no tool, so the tool-result trim cannot affect it. Its 3.40 → 3.67 s shift shows run-to-run noise of about ±0.3 s.
- Typical search runs land at 4.68–4.82 s in the baseline, the short prompt and the trimmed results alike. The model's time to decide on a tool and speak doesn't depend on a few hundred bytes of prompt or result.
- With the acknowledgement clip, the user hears something 3.4 s after a search request in every variant.
- Final numbers are unchanged: **3.4 s** for chit-chat and **4.8 s** for a search, against 3.3 s / 4.6 s in the table above, measured on a different day.

Reproduce with `python -m scripts.voice_latency latency --trials 4 --silence 1400:4000 1000:2000`. Add `--transcription-mode min_latency` to test that setting. `python -m scripts.voice_latency split` replays the "red umbrellas … also yellow ones" case and prints the full event sequence.

### Tuning and diagnostics
Add these to the URL to tune the pipeline without redeploying:

| Parameter | Effect |
|---|---|
| `?debug=1` | Shows an on-screen log (top left) and writes `[voice]` lines to the console: underruns, acknowledgements, local pauses and echo checks, server speech events with the delay after the local pause, discarded audio, and reply status. |
| `&vad=0.03` | Local detector threshold (mic RMS, 0–1). Raise it if the agent's own voice causes pauses, and lower it if your voice doesn't. |
| `&svad=0.5` | Overrides AssemblyAI's `vad_threshold` (0–1). |
| `&idelay=0` | Sends `interruption_delay` (0–1000 ms) to AssemblyAI's turn detection. |
