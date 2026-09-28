"""Store-scoped product reads, writes, and one comparison payload for UI and voice."""

from __future__ import annotations

import math
import os
from pathlib import Path
from threading import Lock
from typing import Any

from backend.services.catalog import (
    CATALOG_DIR,
    CONFIDENCE_CUTOFF,
    CatalogManifest,
    Product,
    load_catalog,
    publish_catalog,
)

_write_lock = Lock()

def active_slug() -> str:
    return os.getenv("ACTIVE_CATALOG", "umbrella").strip()


def get_catalog(version: str | None = None) -> dict:
    return load_catalog(active_slug(), version, base=Path(os.getenv("CATALOG_ROOT", str(CATALOG_DIR))))


def get_all_products() -> list[dict]:
    return get_catalog()["products"]


def get_product_by_id(product_id: str, version: str | None = None) -> dict | None:
    for product in get_catalog(version)["products"]:
        if product["id"] == str(product_id):
            return product
    return None


def add_product(product: dict) -> dict:
    """Append a validated listing by publishing a new immutable catalog version."""
    with _write_lock:
        catalog = get_catalog()
        manifest = CatalogManifest.model_validate(catalog["manifest"])
        listing = Product.model_validate(product).model_dump(mode="json")
        rules = {attribute.key: attribute for attribute in manifest.attributes}
        if set(listing["attributes"]) - set(rules):
            raise ValueError("product contains attributes outside the active category")
        for key, value in listing["attributes"].items():
            kind = rules[key].kind
            if kind == "number" and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)):
                raise ValueError(f"{key} must be a finite number")
            if kind == "boolean" and not isinstance(value, bool):
                raise ValueError(f"{key} must be boolean")
            if kind in ("text", "enum") and not isinstance(value, str):
                raise ValueError(f"{key} must be text")
        products = catalog["products"]
        if any(p["id"] == listing["id"] for p in products):
            raise ValueError("product ID already exists")
        version = publish_catalog(manifest, [*products, listing], base=Path(os.getenv("CATALOG_ROOT", str(CATALOG_DIR))))
        return {**listing, "catalog_version": version}


def _value(product: dict, key: str) -> Any:
    if key in product.get("attributes", {}):
        return product["attributes"][key]
    return product.get(key)


def _display(value: Any, key: str, unit: str, currency: str, product: dict) -> str:
    if value is None or value == "":
        return "—"
    if key == "price":
        symbol = "$" if currency == "USD" else f"{currency} "
        return f"{symbol}{float(value):.2f}"
    if key == "rating":
        return f"{value} ⭐ ({product.get('review_count', 0)} reviews)"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, list):
        return "; ".join(str(item) for item in value)
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return f"{value} {unit}".strip()


def compare_products(ids: list[str], version: str | None = None) -> dict:
    catalog = get_catalog(version)
    manifest = CatalogManifest.model_validate(catalog["manifest"])
    by_id = {product["id"]: product for product in catalog["products"]}
    products = [by_id[pid] for pid in ids if pid in by_id]
    if not products:
        return {"version": catalog["version"], "products": [], "matrix": []}
    rules = {attribute.key: attribute for attribute in manifest.attributes}
    cutoff = float(os.getenv("COMPARISON_CONFIDENCE_CUTOFF", str(CONFIDENCE_CUTOFF)))
    matrix = []
    for key in manifest.comparison_fields:
        rule = rules.get(key)
        label = rule.label if rule else {"price": "Price", "rating": "Rating", "brand": "Brand", "color": "Color", "pros": "Pros", "cons": "Cons"}[key]
        unit = rule.unit if rule else ""
        raw = [_value(product, key) for product in products]
        if all(value is None or value == "" for value in raw):
            continue
        if key == "price":
            direction, confidence, rationale = "lower", 1.0, "Lower listed price."
        elif key == "rating":
            direction, confidence, rationale = "higher", 1.0, "Higher customer rating."
        elif rule:
            direction, confidence, rationale = rule.direction, rule.confidence, rule.rationale
        else:
            direction, confidence, rationale = "none", 0.0, ""
        if confidence < cutoff:
            direction = "none"
        best_indexes: list[int] = []
        if direction != "none" and len(raw) > 1 and all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in raw):
            target = min(raw) if direction == "lower" else max(raw)
            if any(value != target for value in raw):
                best_indexes = [index for index, value in enumerate(raw) if value == target]
        matrix.append({
            "key": key, "field": label,
            "values": [_display(value, key, unit, manifest.currency, product) for value, product in zip(raw, products)],
            "raw_values": raw, "unit": unit, "direction": direction,
            "confidence": confidence, "rationale": rationale, "best_indexes": best_indexes,
        })
    return {
        "version": catalog["version"],
        "products": [{"id": p["id"], "name": p["name"], "image_url": p["image_url"]} for p in products],
        "matrix": matrix,
    }
