"""VoiceCart AI — FastAPI Backend Server."""

from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.services.product_service import (
    get_all_products,
    get_product_by_id,
    search_products,
    compare_products,
)

import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="VoiceCart AI", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------

@app.get("/api/products")
async def api_get_products(
    q: Optional[str] = Query(None, description="Search query"),
    brand: Optional[str] = Query(None),
    min_price: Optional[float] = Query(None),
    max_price: Optional[float] = Query(None),
    min_rating: Optional[float] = Query(None),
    min_wind: Optional[int] = Query(None),
):
    """Return all products with optional filtering."""
    products = get_all_products()

    if q:
        products = search_products(q)
    if brand:
        products = [p for p in products if p["brand"].lower() == brand.lower()]
    if min_price is not None:
        products = [p for p in products if p["price"] >= min_price]
    if max_price is not None:
        products = [p for p in products if p["price"] <= max_price]
    if min_rating is not None:
        products = [p for p in products if p["rating"] >= min_rating]
    if min_wind is not None:
        products = [p for p in products if p["specs"]["wind_rating_mph"] >= min_wind]

    return products


@app.get("/api/products/{product_id}")
async def api_get_product(product_id: str):
    """Return a single product with full reviews."""
    product = get_product_by_id(product_id)
    if product is None:
        return JSONResponse(status_code=404, content={"error": "Product not found"})
    return product


class CompareRequest(BaseModel):
    ids: List[str]


@app.post("/api/products/compare")
async def api_compare(body: CompareRequest):
    """Accept an array of IDs and return comparison matrix payload."""
    result = compare_products(body.ids)
    return result


# ---------------------------------------------------------------------------
# WebSocket — voice streaming stub (connected in a later step)
# ---------------------------------------------------------------------------

@app.websocket("/ws/voice")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_bytes()
            # Future: pipe to AssemblyAI and return transcripts/commands
    except WebSocketDisconnect:
        logger.info("Client disconnected")


# ---------------------------------------------------------------------------
# Static file serving — MUST come last so API routes take priority
# ---------------------------------------------------------------------------

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
