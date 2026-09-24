# VoiceCart AI
*Next-gen Voice-Driven E-Commerce MVP, powered by AssemblyAI Streaming STT.*

## Problem & Solution
Traditional GUI search in e-commerce can be clunky, especially on mobile devices or when users have specific, multi-attribute queries (e.g., "Show me windproof umbrellas under $45"). 
VoiceCart AI provides a real-time, voice-native shopping experience. By embedding an intelligent voice agent directly into the shopping UI, users can search, compare, and check out hands-free.

## AssemblyAI Key Highlights
- **Real-time Streaming STT:** Utilizes AssemblyAI's low-latency WebSockets API to process user intent instantly.
- **Barge-in Support:** The agent's local speech output is immediately interrupted when the user starts speaking, ensuring a natural conversational flow.

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
