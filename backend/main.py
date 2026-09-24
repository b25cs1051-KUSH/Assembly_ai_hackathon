from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from backend.services.product_service import get_all_products, search_products, get_product_by_id
from backend.services.assemblyai_service import AssemblyAIService
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="VoiceCart AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API Routes
@app.get("/api/products")
async def api_get_products():
    return get_all_products()

@app.get("/api/products/search")
async def api_search_products(q: str):
    return search_products(q)

@app.get("/api/products/{product_id}")
async def api_get_product(product_id: str):
    return get_product_by_id(product_id)

# WebSocket Route for AssemblyAI Streaming
@app.websocket("/ws/voice")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    aai_service = AssemblyAIService(websocket)
    try:
        await aai_service.start()
    except WebSocketDisconnect:
        logger.info("Client disconnected")
    finally:
        await aai_service.close()

app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
