"""VoiceCart AI — FastAPI Backend Server."""

import logging
import secrets
import uuid
from pathlib import Path

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError

from backend import config
from backend.services.catalog import CatalogManifest, Product, normalize_catalog
from backend.services.product_service import (
    add_product,
    compare_products,
    get_all_products,
    get_catalog,
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

@app.get("/api/catalog")
async def api_get_catalog():
    """Return products and the matching category manifest as one versioned snapshot."""
    return get_catalog()


@app.get("/api/products")
async def api_get_products():
    return get_all_products()


@app.get("/api/products/{product_id}")
async def api_get_product(product_id: str, version: str | None = None):
    product = get_product_by_id(product_id, version)
    if product is None:
        return JSONResponse(status_code=404, content={"error": "Product not found"})
    return product


class CompareRequest(BaseModel):
    ids: list[str]
    version: str | None = None


@app.post("/api/products/compare")
async def api_compare(body: CompareRequest):
    try:
        return compare_products(body.ids, body.version)
    except (FileNotFoundError, ValueError):
        raise HTTPException(status_code=409, detail="Catalog version is no longer available; reload the store")


@app.post("/api/admin/products", status_code=201)
def api_add_product(body: dict, x_admin_password: str = Header(default="")):
    """Add a listing to the active category; this endpoint is never an agent tool."""
    if not config.ADMIN_PASSWORD:
        raise HTTPException(status_code=503, detail="Admin password is not configured")
    if not secrets.compare_digest(x_admin_password, config.ADMIN_PASSWORD):
        raise HTTPException(status_code=401, detail="Incorrect admin password")

    catalog = get_catalog()
    manifest = CatalogManifest.model_validate(catalog["manifest"])
    existing = {p["id"] for p in catalog["products"]}
    if all(pid.isdigit() for pid in existing):
        next_id = str(max((int(pid) for pid in existing), default=0) + 1)
    else:
        next_id = f"{manifest.category_slug}-{uuid.uuid4().hex[:12]}"
    try:
        if manifest.presentation == "umbrella_demo" and "attributes" not in body:
            # Preserve the existing umbrella editor's request format.
            source = {**body, "id": next_id, "rating": 0, "review_count": 0,
                      "reviews": [], "reviews_summary": "No customer reviews yet."}
            product = normalize_catalog([source], manifest)[0]
        else:
            product = Product.model_validate({
                **body, "id": next_id, "currency": manifest.currency,
                "rating": None, "review_count": 0, "reviews": [],
                "reviews_summary": "No customer reviews yet.",
            }).model_dump(mode="json")
        allowed = {attribute.key for attribute in manifest.attributes}
        if set(product["attributes"]) - allowed:
            raise ValueError("Unknown category attribute")
        text_values = [product["name"], product["description"], product["brand"],
                       *product["pros"], *product["cons"],
                       *[str(value) for value in product["attributes"].values() if isinstance(value, str)]]
        if any("<" in value or ">" in value for value in text_values):
            raise ValueError("Text fields cannot contain HTML")
        return add_product(product)
    except (ValidationError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
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
