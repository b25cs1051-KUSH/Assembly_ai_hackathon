import json
from pathlib import Path
from typing import List
from backend.models.product import Product

DATA_FILE = Path(__file__).parent.parent.parent / "data" / "products.json"

def load_products() -> List[dict]:
    if DATA_FILE.exists():
        with open(DATA_FILE, "r") as f:
            return json.load(f)
    return []

def get_all_products() -> List[dict]:
    return load_products()

def get_product_by_id(product_id: str) -> dict:
    products = load_products()
    for p in products:
        if p["id"] == product_id:
            return p
    return None

def search_products(query: str) -> List[dict]:
    products = load_products()
    query = query.lower()
    return [
        p for p in products 
        if query in p["name"].lower() or query in p["brand"].lower() or query in p["description"].lower()
    ]
