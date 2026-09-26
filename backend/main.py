"""VoiceCart AI — FastAPI Backend Server."""

import logging
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import config
from backend.services.product_service import (
    compare_products,
    get_all_products,
    get_product_by_id,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# No CORS middleware on purpose: the frontend is served from this same app, and
# allowing other origins would let any website mint voice tokens on our credits.
app = FastAPI(title="VoiceCart AI", version="0.1.0")

# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------

@app.get("/api/products")
async def api_get_products():
    """Return the whole catalog; the browser filters it (the grid and the voice agent's search share one rule)."""
    return get_all_products()


@app.get("/api/products/{product_id}")
async def api_get_product(product_id: str):
    """Return a single product with full reviews."""
    product = get_product_by_id(product_id)
    if product is None:
        return JSONResponse(status_code=404, content={"error": "Product not found"})
    return product


class CompareRequest(BaseModel):
    ids: list[str]


@app.post("/api/products/compare")
async def api_compare(body: CompareRequest):
    """Accept an array of IDs and return comparison matrix payload."""
    result = compare_products(body.ids)
    return result


# ---------------------------------------------------------------------------
# Voice Agent token — the browser connects to AssemblyAI directly with this
# single-use temporary token, so the API key never leaves the server.
# ---------------------------------------------------------------------------

VOICE_TOKEN_URL = "https://agents.assemblyai.com/v1/token"


@app.get("/api/token")
async def api_voice_token():
    """Mint a single-use Voice Agent API token for one browser session."""
    no_store = {"Cache-Control": "no-store"}
    if not config.ASSEMBLYAI_API_KEY:
        return JSONResponse(
            status_code=500,
            content={"error": "ASSEMBLYAI_API_KEY is not set on the server"},
            headers=no_store,
        )

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(
                VOICE_TOKEN_URL,
                params={
                    "expires_in_seconds": config.VOICE_TOKEN_EXPIRES_SECONDS,
                    "max_session_duration_seconds": config.VOICE_MAX_SESSION_SECONDS,
                },
                headers={"Authorization": f"Bearer {config.ASSEMBLYAI_API_KEY}"},
            )
    except httpx.HTTPError as exc:
        logger.error("Voice token request failed: %s", exc)
        return JSONResponse(
            status_code=502, content={"error": "Could not reach AssemblyAI"}, headers=no_store
        )

    if res.status_code != 200:
        # Log the upstream body for debugging; don't forward it to the browser.
        logger.error("Voice token request returned %s: %s", res.status_code, res.text[:300])
        return JSONResponse(
            status_code=502,
            content={"error": f"AssemblyAI token request failed ({res.status_code})"},
            headers=no_store,
        )

    token = res.json().get("token")
    if not token:
        logger.error("Voice token response had no token field")
        return JSONResponse(
            status_code=502, content={"error": "AssemblyAI returned no token"}, headers=no_store
        )
    return JSONResponse(content={"token": token}, headers=no_store)


# ---------------------------------------------------------------------------
# Static file serving — MUST come last so API routes take priority
# ---------------------------------------------------------------------------

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
