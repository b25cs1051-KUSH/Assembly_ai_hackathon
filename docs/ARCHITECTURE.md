# VoiceCart AI Architecture

## Overview
The architecture is designed to support real-time, low-latency interactions via voice. We minimize network latency by handling TTS (Text-to-Speech) locally using the browser's Web Speech API and handle STT (Speech-to-Text) using AssemblyAI's WebSocket streaming endpoints.

## Components
1. **Frontend (Browser)**
   - Captures microphone input natively (AudioContext/MediaRecorder).
   - Sends binary PCM chunks via WebSocket to the Backend.
   - Listens for WebSocket JSON messages (Commands, Transcripts).
   - Manages UI updates (`UIRenderer`).
   - Plays agent responses natively using `window.speechSynthesis`.
   - **Barge-in Implementation:** The moment an `INTERRUPT` signal is received (fired when AssemblyAI detects partial speech), the frontend calls `speechSynthesis.cancel()`.

2. **Backend (FastAPI)**
   - Bridges the Frontend and AssemblyAI via a persistent WebSocket.
   - Forwards audio packets directly to AssemblyAI `RealtimeTranscriber`.
   - Parses intents from transcripts in `AgentBrain`.
   - Fetches product data via `ProductService`.

3. **AssemblyAI (3rd Party)**
   - Streaming STT engine running continuously as long as the mic is on.
