"""VoiceCart AI — FastAPI Backend Server."""

import logging
import secrets
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend import config
from backend.services.product_service import (
    add_product,
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


class NewProductSpecs(BaseModel):
    frame_material: str = Field(min_length=1, max_length=120)
    canopy_size_inches: int = Field(gt=0, le=120)
    wind_rating_mph: int = Field(ge=0, le=250)
    weight_oz: float = Field(gt=0, le=200)
    automatic_open: bool


class NewProduct(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    brand: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=120)
    color: str = Field(min_length=1, max_length=60)
    color_family: str = Field(min_length=1, max_length=60)
    price: float = Field(gt=0, le=10000)
    description: str = Field(min_length=1, max_length=1000)
    image_url: str = Field(min_length=1, max_length=2000)
    specs: NewProductSpecs
    pros: list[str] = Field(default_factory=list, max_length=5)
    cons: list[str] = Field(default_factory=list, max_length=5)


@app.post("/api/admin/products", status_code=201)
def api_add_product(body: NewProduct, x_admin_password: str = Header(default="")):
    """Add a manually entered listing; no voice-agent action uses this endpoint."""
    if not config.ADMIN_PASSWORD:
        raise HTTPException(status_code=503, detail="Admin password is not configured")
    if not secrets.compare_digest(x_admin_password, config.ADMIN_PASSWORD):
        raise HTTPException(status_code=401, detail="Incorrect admin password")

    product = body.model_dump() if hasattr(body, "model_dump") else body.dict()
    product["specs"] = dict(product["specs"])
    for key in ("name", "brand", "model", "color", "color_family", "description",
                "image_url"):
        product[key] = product[key].strip()
    product["specs"]["frame_material"] = product["specs"]["frame_material"].strip()
    product["pros"] = [item.strip() for item in product["pros"] if item.strip()]
    product["cons"] = [item.strip() for item in product["cons"] if item.strip()]

    text_values = [product[key] for key in ("name", "brand", "model", "color",
                   "color_family", "description", "image_url")]
    text_values += [product["specs"]["frame_material"], *product["pros"], *product["cons"]]
    if any(not value or "<" in value or ">" in value for value in text_values):
        raise HTTPException(status_code=422, detail="Fields cannot be blank or contain HTML")
    if '"' in product["name"]:
        raise HTTPException(status_code=422, detail="Product name cannot contain double quotes")
    if any(len(item) > 160 for item in (*product["pros"], *product["cons"])):
        raise HTTPException(status_code=422, detail="Pros and cons must be 160 characters or less")

    image = urlparse(product["image_url"])
    if (image.scheme not in ("http", "https") or not image.netloc
            or any(char in product["image_url"] for char in ('"', "'", "`", "\\"))):
        raise HTTPException(status_code=422, detail="Image URL must be a valid HTTP(S) URL")

    product.update(rating=0, review_count=0, reviews=[],
                   reviews_summary="No customer reviews yet.")
    try:
        return add_product(product)
    except OSError:
        logger.exception("Could not save product catalog")
        raise HTTPException(status_code=503, detail="Catalog storage is unavailable")


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
