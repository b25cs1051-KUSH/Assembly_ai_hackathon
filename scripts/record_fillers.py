"""Record the agent's short acknowledgement lines in its own voice.

The page plays one of these the moment the agent calls a tool, so the user hears a reply while the
model is still working. Each line is spoken by the Voice Agent API itself (same default voice as the
live agent), checked against its transcript, trimmed of silence and saved as raw 24 kHz PCM16 to
frontend/audio/ack_<tool>_<n>.pcm, with the texts in frontend/audio/acks.json.

Usage (from the repo root, with ASSEMBLYAI_API_KEY in .env):
    python -m scripts.record_fillers
"""

import array
import asyncio
import base64
import json
import re
from pathlib import Path

import websockets

from scripts.voice_latency import RATE, SILENCE, WS_URL, mint_token

OUT_DIR = Path(__file__).resolve().parent.parent / "frontend" / "audio"
LINES = {
    "search_products": [
        "Sure, let me look.",
        "Let me find the best options for you.",
        "One moment, let me check what we have.",
    ],
}
PROMPT = "You read sentences aloud. When asked to say a sentence, say exactly that sentence and nothing else."


def normalise(text: str) -> str:
    return re.sub(r"[^a-z ]", "", text.lower()).strip()


def trim(pcm: bytes, level: int = 300, pad_s: float = 0.03) -> bytes:
    """Cut leading/trailing silence, keeping a short pad so the clip doesn't click."""
    s = array.array("h", pcm)
    loud = [i for i, v in enumerate(s) if abs(v) > level]
    if not loud:
        return pcm
    pad = int(pad_s * RATE)
    return s[max(0, loud[0] - pad):min(len(s), loud[-1] + pad)].tobytes()


async def say(ws, text: str) -> tuple[bytes, str]:
    await ws.send(json.dumps({"type": "reply.create",
                              "instructions": f'Say exactly this sentence and nothing else: "{text}"'}))
    audio, spoken = bytearray(), ""
    async for raw in ws:
        e = json.loads(raw)
        if e["type"] == "reply.audio":
            audio += base64.b64decode(e["data"])
        elif e["type"] == "transcript.agent":
            spoken = e.get("text", "")
        elif e["type"] == "reply.done":
            return bytes(audio), spoken
        elif e["type"] == "session.error":
            raise RuntimeError(e)
    raise RuntimeError("socket closed")


async def main():
    OUT_DIR.mkdir(exist_ok=True)
    manifest = {}
    async with websockets.connect(f"{WS_URL}?token={await mint_token()}", max_size=None) as ws:
        await ws.send(json.dumps({"type": "session.update", "session": {"system_prompt": PROMPT}}))
        while json.loads(await ws.recv())["type"] != "session.ready":
            pass

        async def keep_mic_open():  # the session expects a live input stream
            while True:
                await ws.send(json.dumps({"type": "input.audio", "audio": base64.b64encode(SILENCE).decode()}))
                await asyncio.sleep(0.05)
        mic = asyncio.create_task(keep_mic_open())

        for tool, lines in LINES.items():
            manifest[tool] = []
            for n, text in enumerate(lines, 1):
                for attempt in range(3):
                    pcm, spoken = await say(ws, text)
                    if normalise(spoken) == normalise(text):
                        break
                    print(f"  retry: asked {text!r}, got {spoken!r}")
                else:
                    raise SystemExit(f"could not record {text!r}")
                clip = trim(pcm)
                name = f"ack_{tool}_{n}.pcm"
                (OUT_DIR / name).write_bytes(clip)
                manifest[tool].append({"file": f"audio/{name}", "text": text})
                print(f"{name}: {len(clip) / 2 / RATE:.2f}s  {text!r}")
        mic.cancel()
        await ws.send(json.dumps({"type": "session.end"}))
    (OUT_DIR / "acks.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
