"""Measure Voice Agent API reply latency and reply-audio chunk timing.

Streams pre-recorded speech (scripts/audio/*.wav, 24 kHz PCM16) to the Voice Agent API at
real-time speed with the same session config as the browser, answers search_products the way
the page does, and reports:

- turn end:      end of user speech → input.speech.stopped / reply.started
- time to audio: end of user speech → first reply.audio
- tool round trip: tool.call → tool.result sent → next reply.started
- pre-buffer:    the smallest head start that plays a reply's chunks without a gap,
                 max_i(arrival_i − first_arrival − audio_before_i)

Usage (from the repo root, with ASSEMBLYAI_API_KEY in .env):
    python -m scripts.voice_latency latency --trials 5 --silence 1400:4000 800:1500
    python -m scripts.voice_latency split --silence 1400:4000
    python -m scripts.voice_latency capture --trials 3 --silence 1400:4000 1000:2000 --lines chitchat search
        (saves reply audio + arrival times to scripts/traces/ for scripts/replay_playback.js)
"""

import argparse
import array
import asyncio
import base64
import json
import re
import statistics
import time
import wave
from pathlib import Path

import httpx
import websockets

from backend import config

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = Path(__file__).resolve().parent / "audio"
TRACES_DIR = Path(__file__).resolve().parent / "traces"
WS_URL = "wss://agents.assemblyai.com/v1/ws"
TOKEN_URL = "https://agents.assemblyai.com/v1/token"
RATE = 24000
CHUNK_BYTES = 2400  # 50 ms of PCM16 mono, like the browser's mic worklet
SILENCE = bytes(CHUNK_BYTES)

PRODUCTS = json.loads((ROOT / "data" / "products.json").read_text(encoding="utf-8"))
BRANDS = sorted({p["brand"] for p in PRODUCTS}, key=str.lower)
BARE_PROMPT = "You are a friendly assistant. Reply in one short spoken sentence."
SORT_OPTIONS = ["relevance", "price_low_to_high", "price_high_to_low", "rating", "lightest", "most_wind_resistant"]


def browser_system_prompt() -> str:
    """The exact prompt the page sends, read from voice_agent.js so the two never drift."""
    js = (ROOT / "frontend" / "js" / "voice_agent.js").read_text(encoding="utf-8")
    return re.search(r"const SYSTEM_PROMPT = `(.*?)`;", js, re.DOTALL).group(1)


# Mirrors definitions() in frontend/js/agent_tools.js
TOOLS = [
    {
        "type": "function",
        "name": "search_products",
        "description": "Filter the store's umbrellas and show the matches on screen; use it whenever the user "
        "describes what they want or changes a requirement.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": 'Keywords that must appear in the product name or '
                          'description, such as "bubble", "kids" or "golf". Leave out for price, wind, weight or '
                          'rating requirements.'},
                "brand": {"type": "string", "enum": BRANDS, "description": "Only this brand."},
                "max_price": {"type": "number", "description": "Highest price in US dollars."},
                "min_rating": {"type": "number", "description": "Lowest average star rating, from 1 to 5."},
                "min_wind_mph": {"type": "number", "description": "Lowest wind rating in miles per hour. "
                                 "Windproof usually means 50 or more."},
                "max_weight_oz": {"type": "number", "description": "Highest weight in ounces. Light or backpack "
                                  "friendly usually means 14 or less."},
                "automatic_open": {"type": "boolean", "description": "True to show only umbrellas that open "
                                   "with one button."},
                "sort_by": {"type": "string", "enum": SORT_OPTIONS, "description": "Result order. Default is relevance."},
            },
        },
    }
]


def search_products(args: dict) -> dict:
    """Same filtering and result shape as search_products in agent_tools.js / applyFilters in app.js."""
    words = str(args.get("query") or "").lower().split()
    out = []
    for p in PRODUCTS:
        s = p["specs"]
        if args.get("brand") and p["brand"] != args["brand"]:
            continue
        if p["price"] > args.get("max_price", float("inf")) or p["rating"] < args.get("min_rating", 0):
            continue
        if s["wind_rating_mph"] < args.get("min_wind_mph", 0) or s["weight_oz"] > args.get("max_weight_oz", float("inf")):
            continue
        if args.get("automatic_open") and not s["automatic_open"]:
            continue
        hay = f'{p["name"]} {p["brand"]} {p["description"]} {s["frame_material"]}'.lower()
        if not all(w in hay for w in words):
            continue
        out.append(p)
    key = {
        "price_low_to_high": lambda p: p["price"],
        "price_high_to_low": lambda p: -p["price"],
        "rating": lambda p: -p["rating"],
        "lightest": lambda p: p["specs"]["weight_oz"],
        "most_wind_resistant": lambda p: -p["specs"]["wind_rating_mph"],
    }.get(args.get("sort_by"))
    if key:
        out.sort(key=key)
    if not out:
        return {"total_matches": 0, "results": [],
                "note": "No umbrellas match these filters. Tell the user and offer to relax one of them."}
    return {"total_matches": len(out), "results": [
        {"position": i + 1, "id": p["id"], "name": p["name"], "brand": p["brand"], "price": p["price"],
         "rating": p["rating"], "wind_mph": p["specs"]["wind_rating_mph"], "weight_oz": p["specs"]["weight_oz"],
         "automatic_open": p["specs"]["automatic_open"]} for i, p in enumerate(out[:5])]}


def load_pcm(name: str) -> bytes:
    with wave.open(str(AUDIO_DIR / f"{name}.wav"), "rb") as w:
        assert w.getframerate() == RATE and w.getsampwidth() == 2 and w.getnchannels() == 1, name
        return w.readframes(w.getnframes())


def voice_span(pcm: bytes) -> tuple[float, float]:
    """(first, last) moment of actual voice in a clip, in seconds; clips carry leading/trailing silence."""
    samples = array.array("h", pcm)
    loud = [i for i, v in enumerate(samples) if abs(v) > 800]
    return loud[0] / RATE, loud[-1] / RATE


async def mint_token() -> str:
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(TOKEN_URL, params={"expires_in_seconds": 60, "max_session_duration_seconds": 300},
                               headers={"Authorization": f"Bearer {config.ASSEMBLYAI_API_KEY}"})
        res.raise_for_status()
        return res.json()["token"]


async def run_session(clips: list[tuple[str, float]], silence: tuple[int, int], tail_s: float = 15.0,
                      bare: bool = False, voice: str | None = None) -> dict:
    """Streams each clip followed by its gap of silence. Returns the event log (times in s from session start)."""
    t0 = time.perf_counter()
    now = lambda: time.perf_counter() - t0
    events, speech = [], []  # speech: (start, end) of each clip as sent
    ready = asyncio.Event()
    state = {"turn_active": False, "pending": [], "last_activity": 0.0}

    async with websockets.connect(f"{WS_URL}?token={await mint_token()}", max_size=None) as ws:
        await ws.send(json.dumps({"type": "session.update", "session": {
            # bare: a one-line prompt and no tools, to separate platform latency from our config
            "system_prompt": BARE_PROMPT if bare else browser_system_prompt(),
            "tools": [] if bare else TOOLS,
            "input": {"keyterms": ["VoiceCart", *BRANDS], "turn_detection": {
                "vad_threshold": 0.5, "min_silence": silence[0], "max_silence": silence[1],
                "interrupt_response": True}},
            **({"output": {"voice": voice}} if voice else {}),
        }}))

        async def flush():
            if not state["turn_active"]:
                while state["pending"]:
                    msg = state["pending"].pop(0)
                    await ws.send(json.dumps(msg))
                    events.append({"t": now(), "type": "tool.result.sent", "call_id": msg["call_id"]})

        async def receive():
            async for raw in ws:
                e = json.loads(raw)
                rec = {"t": now(), "type": e["type"]}
                if e["type"] == "reply.audio":
                    rec["_pcm"] = base64.b64decode(e["data"])  # kept for `capture`; "_" keys are never printed
                    rec["dur"] = len(rec["_pcm"]) / 2 / RATE
                for k in ("reply_id", "status", "name", "arguments", "text", "code", "message", "interrupted"):
                    if k in e:
                        rec[k] = e[k]
                if e["type"] not in ("transcript.agent.delta", "transcript.user.delta"):
                    events.append(rec)
                state["last_activity"] = now()
                if e["type"] == "session.ready":
                    ready.set()
                elif e["type"] in ("reply.started", "input.speech.started"):
                    state["turn_active"] = True
                elif e["type"] == "reply.done":
                    state["turn_active"] = False
                    if e.get("status") == "interrupted":
                        state["pending"].clear()
                    await flush()
                elif e["type"] == "tool.call":
                    result = search_products(e.get("arguments") or {})
                    state["pending"].append({"type": "tool.result", "call_id": e["call_id"], "result": json.dumps(result)})
                    await flush()
                elif e["type"] == "session.ended":
                    return

        async def stream(pcm: bytes):
            start = time.perf_counter()
            for i in range(0, len(pcm), CHUNK_BYTES):
                chunk = pcm[i:i + CHUNK_BYTES]
                await ws.send(json.dumps({"type": "input.audio", "audio": base64.b64encode(chunk).decode()}))
                # Real-time pacing against the wall clock, so drift does not accumulate.
                await asyncio.sleep(max(0, start + (i + len(chunk)) / 2 / RATE - time.perf_counter()))

        async def send_audio():
            await ready.wait()
            await stream(SILENCE * 20)  # 1 s of silence to settle
            for name, gap in clips:
                pcm = load_pcm(name)
                s = now()
                await stream(pcm)
                v0, v1 = voice_span(pcm)
                speech.append((s + v0, s + v1))  # when the user actually starts/stops talking
                await stream(SILENCE * int(gap / 0.05))
            # Keep the mic "open" with silence until the agent has been quiet for 2.5 s after the last speech.
            end = now()
            while now() - end < tail_s:
                await stream(SILENCE * 10)
                if not state["turn_active"] and not state["pending"] and now() - state["last_activity"] > 2.5 \
                        and any(ev["type"] == "reply.audio" and ev["t"] > end for ev in events):
                    break
            await ws.send(json.dumps({"type": "session.end"}))

        rx = asyncio.create_task(receive())
        await send_audio()
        try:
            await asyncio.wait_for(rx, 5)
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            rx.cancel()
    return {"events": events, "speech": speech}


def replies(events: list[dict]) -> list[dict]:
    """Groups reply.audio chunks by the reply (reply.started … reply.done) they arrived in."""
    out, cur = [], None
    for e in events:
        if e["type"] == "reply.started":
            cur = {"started": e["t"], "reply_id": e.get("reply_id"), "chunks": [], "status": None, "text": ""}
            out.append(cur)
        elif e["type"] == "reply.audio" and cur is not None:
            cur["chunks"].append((e["t"], e["dur"]))
            cur.setdefault("pcm", []).append(e["_pcm"])
        elif e["type"] == "transcript.agent" and cur is not None:
            cur["text"] = e.get("text", "")
        elif e["type"] == "reply.done" and cur is not None:
            cur["status"], cur["done"] = e.get("status"), e["t"]
    return out


def prebuffer_needed(chunks: list[tuple[float, float]]) -> float:
    if not chunks:
        return 0.0
    first, played, worst = chunks[0][0], 0.0, 0.0
    for t, dur in chunks:
        worst = max(worst, t - first - played)
        played += dur
    return worst


def analyse_single(run: dict) -> dict:
    ev, (_, speech_end) = run["events"], run["speech"][-1]
    after = [e for e in ev if e["t"] >= speech_end - 0.5]
    first = lambda typ: next((e["t"] for e in after if e["type"] == typ), None)
    audio_replies = [r for r in replies(ev) if r["chunks"] and r["started"] >= speech_end - 0.5]
    tool_call, tool_sent = first("tool.call"), first("tool.result.sent")
    next_reply = next((e["t"] for e in after if e["type"] == "reply.started" and tool_sent and e["t"] > tool_sent), None)
    chunks = [c for r in audio_replies for c in r["chunks"]]
    # The page plays a recorded acknowledgement on tool.call, so the user hears something from then.
    first_sound = min(t for t in (tool_call, chunks[0][0] if chunks else None) if t) if (tool_call or chunks) else None
    return {
        "speech_stopped": (first("input.speech.stopped") or speech_end) - speech_end,
        "reply_started": (first("reply.started") or speech_end) - speech_end,
        "first_audio": (chunks[0][0] - speech_end) if chunks else None,
        "first_sound": (first_sound - speech_end) if first_sound else None,
        "tool_llm": (tool_call - first("reply.started")) if tool_call and first("reply.started") else None,
        "tool_to_reply": (next_reply - tool_sent) if next_reply and tool_sent else None,
        "prebuffer": max((prebuffer_needed(r["chunks"]) for r in audio_replies), default=0.0),
        "chunk_ms": statistics.median(d for _, d in chunks) * 1000 if chunks else None,
        "speed": (sum(d for _, d in chunks) / max(1e-6, chunks[-1][0] - chunks[0][0])) if len(chunks) > 1 else None,
        "said": " | ".join(r["text"] for r in audio_replies),
    }


def fmt(v, unit="ms"):
    if v is None:
        return "   -  "
    return f"{v * 1000:6.0f}" if unit == "ms" else f"{v:6.1f}"


async def cmd_latency(trials: int, settings: list[tuple[int, int]], lines: list[str], bare: bool,
                      voice: str | None = None):
    rows = []
    for ms in settings:
        for line in lines:
            for i in range(trials):
                r = analyse_single(await run_session([(line, 0.0)], ms, bare=bare, voice=voice))
                rows.append((ms, line, r))
                print(f"voice={voice or 'default'} silence={ms[0]}/{ms[1]} {line:8s} #{i + 1}: stopped {fmt(r['speech_stopped'])}  "
                      f"reply {fmt(r['reply_started'])}  first sound {fmt(r['first_sound'])}  first audio {fmt(r['first_audio'])}  "
                      f"tool→reply {fmt(r['tool_to_reply'])}  prebuffer {fmt(r['prebuffer'])}  "
                      f"chunk {fmt((r['chunk_ms'] or 0) / 1000)}  speed {fmt(r['speed'], 'x')}x  | {r['said'][:70]}",
                      flush=True)
    print("\nMedians (max) in ms, measured from the end of user speech:")
    print("silence    line      first_sound        first_audio        reply_started      tool→reply         prebuffer")
    for ms in settings:
        for line in lines:
            rs = [r for m, l_, r in rows if m == ms and l_ == line]
            cols = [_stat(rs, k) for k in ("first_sound", "first_audio", "reply_started", "tool_to_reply", "prebuffer")]
            print(f"{ms[0]:4d}/{ms[1]:<5d} {line:9s} " + "    ".join(cols))


def _stat(rs: list[dict], key: str) -> str:
    v = [r[key] for r in rs if r[key] is not None]
    return f"{statistics.median(v) * 1000:6.0f} ({max(v) * 1000:5.0f})" if v else "     -       "


async def cmd_split(silence: tuple[int, int], gap: float):
    run = await run_session([("red", gap), ("yellow", 0.0)], silence)
    (s1, e1), (s2, e2) = run["speech"]
    print(f"clip 'red' {s1:.2f}–{e1:.2f}s, gap {gap}s, clip 'yellow' {s2:.2f}–{e2:.2f}s\n")
    audio_run = None
    for e in run["events"]:
        if e["type"] == "reply.audio":
            audio_run = (audio_run or [e["t"], e["t"], 0])
            audio_run[1], audio_run[2] = e["t"], audio_run[2] + 1
            continue
        if audio_run:
            print(f"{audio_run[0]:7.2f}s   reply.audio ×{audio_run[2]} (until {audio_run[1]:.2f}s)")
            audio_run = None
        extra = {k: v for k, v in e.items() if k not in ("t", "type") and not k.startswith("_")}
        print(f"{e['t']:7.2f}s   {e['type']:22s} {json.dumps(extra)[:110] if extra else ''}")
    if audio_run:
        print(f"{audio_run[0]:7.2f}s   reply.audio ×{audio_run[2]} (until {audio_run[1]:.2f}s)")
    print("\nReplies:")
    for r in replies(run["events"]):
        print(f"  {r['reply_id']}: started {r['started']:.2f}s, status {r['status']}, "
              f"{len(r['chunks'])} audio chunks, said: {r['text'][:90]}")


async def cmd_capture(trials: int, settings: list[tuple[int, int]], lines: list[str]):
    """Saves each reply's audio and chunk arrival times, for replaying through the playback worklet offline."""
    for ms in settings:
        out = TRACES_DIR / f"{ms[0]}-{ms[1]}"
        out.mkdir(parents=True, exist_ok=True)
        for line in lines:
            for i in range(trials):
                run = await run_session([(line, 0.0)], ms)
                for j, r in enumerate(r for r in replies(run["events"]) if r["chunks"]):
                    name = f"{line}-{i + 1}-{j + 1}"
                    (out / f"{name}.pcm").write_bytes(b"".join(r["pcm"]))
                    t0 = r["chunks"][0][0]
                    (out / f"{name}.json").write_text(json.dumps({
                        "status": r["status"], "text": r["text"],
                        "chunks": [[round(t - t0, 4), round(d * RATE)] for t, d in r["chunks"]],
                    }))
                    print(f"{out.name}/{name}: {len(r['chunks'])} chunks, "
                          f"prebuffer {fmt(prebuffer_needed(r['chunks']))} ms | {r['text'][:70]}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["latency", "split", "capture"])
    ap.add_argument("--trials", type=int, default=5)
    ap.add_argument("--silence", nargs="+", default=["1400:4000"],
                    help="turn_detection min_silence:max_silence pairs in ms")
    ap.add_argument("--lines", nargs="+", default=["chitchat", "search"])
    ap.add_argument("--bare", action="store_true", help="one-line prompt, no tools")
    ap.add_argument("--voice", help="output.voice, e.g. anna, alba, michael (default: the API's default)")
    ap.add_argument("--gap", type=float, default=1.8, help="split mode: silence between the two clips (s)")
    a = ap.parse_args()
    if not config.ASSEMBLYAI_API_KEY:
        raise SystemExit("ASSEMBLYAI_API_KEY is not set (.env)")
    settings = [tuple(int(x) for x in pair.split(":")) for pair in a.silence]
    if a.mode == "latency":
        asyncio.run(cmd_latency(a.trials, settings, a.lines, a.bare, a.voice))
    elif a.mode == "capture":
        asyncio.run(cmd_capture(a.trials, settings, a.lines))
    else:
        for pair in settings:
            print(f"=== silence={pair[0]}/{pair[1]}")
            asyncio.run(cmd_split(pair, a.gap))


if __name__ == "__main__":
    main()
