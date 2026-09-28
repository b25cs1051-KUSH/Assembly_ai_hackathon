"""Product data service — reads JSON dataset and provides query helpers."""

import json
import os
import tempfile
import threading
from pathlib import Path

DATA_FILE = Path(__file__).resolve().parent.parent.parent / "data" / "products.json"

_cache: list[dict] | None = None
_cache_mtime: float | None = None
_write_lock = threading.Lock()


def load_products() -> list[dict]:
    """The catalog, re-read whenever products.json changes so a running server never serves stale data."""
    global _cache, _cache_mtime
    mtime = DATA_FILE.stat().st_mtime
    if _cache is None or mtime != _cache_mtime:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            _cache = json.load(f)
        _cache_mtime = mtime
    return _cache


def get_all_products() -> list[dict]:
    return load_products()


def add_product(product: dict) -> dict:
    """Append a product to the JSON catalog with a unique ID and an atomic replace."""
    global _cache, _cache_mtime
    with _write_lock:
        with open(DATA_FILE, "r", encoding="utf-8") as source:
            products = json.load(source)
        next_id = max((int(p["id"]) for p in products), default=0) + 1
        created = {"id": str(next_id), **product}
        products.append(created)

        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=DATA_FILE.parent,
                prefix=".products-", suffix=".json", delete=False,
            ) as temporary:
                temp_path = temporary.name
                json.dump(products, temporary, ensure_ascii=False, indent=2)
                temporary.write("\n")
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temp_path, DATA_FILE)
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)

        _cache = products
        _cache_mtime = DATA_FILE.stat().st_mtime
        return created


def get_product_by_id(product_id: str) -> dict | None:
    for p in load_products():
        if str(p["id"]) == str(product_id):
            return p
    return None


def compare_products(ids: list[str]) -> dict:
    """Return a structured comparison matrix for the given product IDs."""
    products = [get_product_by_id(pid) for pid in ids]
    products = [p for p in products if p is not None]

    if not products:
        return {"products": [], "matrix": []}

    fields = [
        ("Price", lambda p: f"${p['price']:.2f}"),
        ("Rating", lambda p: f"{p['rating']} ⭐ ({p['review_count']} reviews)"),
        ("Brand", lambda p: p["brand"]),
        ("Color", lambda p: p.get("color", "")),
        ("Wind Resistance", lambda p: f"{p['specs']['wind_rating_mph']} mph"),
        ("Weight", lambda p: f"{p['specs']['weight_oz']} oz"),
        ("Canopy Size", lambda p: f"{p['specs']['canopy_size_inches']}\""),
        ("Frame Material", lambda p: p["specs"]["frame_material"]),
        ("Auto-Open", lambda p: "Yes" if p["specs"]["automatic_open"] else "No"),
        ("Pros", lambda p: "; ".join(p.get("pros", []))),
        ("Cons", lambda p: "; ".join(p.get("cons", []))),
    ]

    matrix = []
    for label, extractor in fields:
        row = {"field": label, "values": [extractor(p) for p in products]}
        matrix.append(row)

    return {
        "products": [{"id": p["id"], "name": p["name"], "image_url": p["image_url"]} for p in products],
        "matrix": matrix,
    }
