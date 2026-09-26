# VoiceCart AI
*Next-gen Voice-Driven E-Commerce MVP, powered by AssemblyAI Streaming STT.*

## Problem & Solution
Traditional GUI search in e-commerce can be clunky, especially on mobile devices or when users have specific, multi-attribute queries (e.g., "Show me windproof umbrellas under $45"). 
VoiceCart AI provides a real-time, voice-native shopping experience. By embedding an intelligent voice agent directly into the shopping UI, users can search, compare, and check out hands-free.

## AssemblyAI Key Highlights
- **Real-time Streaming STT:** Utilizes AssemblyAI's low-latency WebSockets API to process user intent instantly.
- **Barge-in Support:** The agent's local speech output is immediately interrupted when the user starts speaking, ensuring a natural conversational flow.

## How the voice pipeline handles interruptions and playback

The browser talks to AssemblyAI's Voice Agent API directly over a WebSocket. Our server only mints a single-use token, so the API key never reaches the browser. Mic audio goes up as 24 kHz PCM16, and the agent's reply comes back as 24 kHz PCM16 chunks that we schedule with the Web Audio API. Getting this to feel like a real conversation took four fixes.

### 1. Smooth playback: an adaptive jitter buffer
Reply audio arrives in small chunks over the network, and each chunk is scheduled right after the previous one. With a 50 ms head start, one late chunk left the schedule empty and made an audible gap, which sounded like stutter. Each reply now starts 200 ms ahead. Every time playback still runs dry, the buffer grows by 100 ms, up to 500 ms, for the rest of the session. A steady connection keeps the short delay, and a jittery one trades a little latency for smooth speech.

### 2. Instant barge-in: mute and listen
AssemblyAI decides when the user has started speaking (`input.speech.started`). That decision needs a network round trip plus a moment of speech. While the agent is talking, the browser's echo canceller also turns down the user's voice (double-talk suppression), which can delay or hide the user's speech from the server. We add a small energy detector to the mic `AudioWorklet` and handle the first moments of an interruption locally:

1. **Mute.** When the mic level stays above a threshold for 60 ms, the page mutes the agent immediately. The user hears it stop as they start talking. The echo canceller also stops suppressing their voice, so the server hears them clearly.
2. **Listen for 600 ms.** Echo exists only while the agent is audible. If the mic goes quiet while the agent is muted, the sound was the agent's own voice, so the volume comes back. The words played during that half second of mute are lost.
3. **Commit.** If the user is still talking after 600 ms, it's a real interruption. The rest of the reply is dropped, and the agent stays silent until it answers the user's new message.
4. **Safety net.** If the server doesn't react within 2.5 s of the user going quiet, the page asks them to repeat instead of leaving silence.

When the server sends `input.speech.started`, all queued audio is stopped and dropped as well.

### 3. Echo safety: layered defence
On laptop speakers the agent's voice can leak into the mic. Four layers keep the agent from interrupting itself:

1. Browser echo cancellation (`echoCancellation: true`) removes the page's own output from the mic signal. Noise suppression stays off, as AssemblyAI recommends, because the server denoises.
2. The mute-and-listen check in section 2 catches echo that gets through. A false trigger costs about half a second of muted speech, not the whole reply.
3. AssemblyAI's server-side VAD (`vad_threshold`) decides whether a sound is speech before it interrupts.
4. Headphones remove echo entirely. The demo video is recorded with a headset.

### 4. Tool results that respect the conversation
Tools run in the browser and update the page, for example filtering the product grid. Their results go back to the agent only after `reply.done`, as the API requires. If the user interrupted that reply, the results are thrown away so the agent never answers a question the user has moved past.

### Tuning and diagnostics
Add these to the URL to tune the pipeline without redeploying:

| Parameter | Effect |
|---|---|
| `?debug=1` | Shows an on-screen log (top left) and writes `[voice]` lines to the console: playback gaps and buffer growth, local mutes and echo checks, server speech events with the delay after the local mute, and reply status. |
| `&vad=0.03` | Local detector threshold (mic RMS, 0–1). Raise it if the agent's own voice causes mutes, and lower it if your voice doesn't. |
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
