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

### 1. Smooth playback: a jitter buffer
Reply audio arrives in small chunks over the network, and each chunk is scheduled right after the previous one. With a 50 ms head start, one late chunk left the schedule empty and made an audible gap, which sounded like stutter. Each reply now starts 200 ms ahead, and so does playback after any gap. That absorbs normal network jitter and costs about 150 ms before the first word.

### 2. Instant barge-in: local ducking
AssemblyAI decides when the user has started speaking (`input.speech.started`). That decision needs a network round trip plus a moment of speech, so waiting for it alone makes the agent talk over the user for a noticeable beat. We add a small energy detector to the mic `AudioWorklet`:

- When the mic level stays above a threshold for 60 ms, it posts `speech`, and the page drops the agent's volume to 15% right away. The user hears the agent back off as soon as they speak.
- The volume stays down while the user keeps talking. After 300 ms of quiet the worklet posts `silence`, and the volume returns 400 ms later if the server never confirmed speech.
- When the server sends `input.speech.started`, all queued audio is stopped and dropped. The stop always comes from the server.

### 3. Echo safety: the local detector can only duck, never stop
On laptop speakers the agent's own voice can leak into the mic. Browser echo cancellation removes most of it, but if some gets through and trips the local detector, the worst case is a dip in volume, capped at 3 s. Only AssemblyAI's server-side detection can stop the agent, so the agent never interrupts itself because of our local detector.

### 4. Tool results that respect the conversation
Tools run in the browser and update the page, for example filtering the product grid. Their results go back to the agent only after `reply.done`, as the API requires. If the user interrupted that reply, the results are thrown away so the agent never answers a question the user has moved past.

### Tuning and diagnostics
Add these to the URL to tune the pipeline without redeploying:

| Parameter | Effect |
|---|---|
| `?debug=1` | Logs `[voice]` timing to the console: playback gaps, local ducks, server speech events (with the delay after the local duck), reply status, and false barge-ins. |
| `&vad=0.03` | Local detector threshold (mic RMS, 0–1). Raise it if the agent's own voice causes ducks, and lower it if your voice doesn't. |
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
