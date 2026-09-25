"""Runtime settings, read from environment variables (and `.env` in development)."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

ASSEMBLYAI_API_KEY = os.getenv("ASSEMBLYAI_API_KEY", "").strip()

# Voice Agent API temporary-token limits (see /api/token)
VOICE_TOKEN_EXPIRES_SECONDS = 60           # window to open the WebSocket after minting
VOICE_MAX_SESSION_SECONDS = 15 * 60        # hard cap on one voice session
