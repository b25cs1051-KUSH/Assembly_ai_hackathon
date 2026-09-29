"""Validated, versioned catalog bundles shared by the storefront and voice tools."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path
from threading import Lock
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

ROOT = Path(__file__).resolve().parent.parent.parent
CATALOG_DIR = ROOT / "data" / "catalogs"
PATH_RE = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*$")
SLUG_RE = re.compile(r"^[a-z][a-z0-9_]*$")
KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
REQUIRED_FIELDS = {"id", "name", "description", "price", "image_url"}
OPTIONAL_FIELDS = {
    "brand", "rating", "review_count", "reviews", "reviews_summary", "pros", "cons",
    "color", "color_family", "model", "specs", "currency",
}
CONFIDENCE_CUTOFF = 0.30
_publish_lock = Lock()


def get_path(record: dict, path: str) -> Any:
    """Resolve a restricted dotted object path, never an expression."""
    value: Any = record
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


class FilterRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parameter: str
    operator: Literal["equals", "contains", "min", "max"]
    description: str = Field(min_length=1, max_length=240)
    ui_label: str | None = None
    ui_step: float | None = Field(default=None, gt=0)

    @field_validator("parameter")
    @classmethod
    def valid_parameter(cls, value: str) -> str:
        if not KEY_RE.fullmatch(value):
            raise ValueError("filter parameter must be a lowercase identifier")
        return value


class AttributeRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str
    source: str
    label: str = Field(min_length=1, max_length=80)
    kind: Literal["text", "number", "boolean", "enum"]
    unit: str = Field(default="", max_length=24)
    input_units: dict[str, float] = Field(default_factory=dict)
    filters: list[FilterRule] = Field(default_factory=list)
    compare: bool = True
    direction: Literal["higher", "lower", "none"] = "none"
    confidence: float = Field(default=0, ge=0, le=1)
    rationale: str = Field(default="", max_length=500)

    @field_validator("key")
    @classmethod
    def valid_key(cls, value: str) -> str:
        if not KEY_RE.fullmatch(value):
            raise ValueError("attribute key must be a lowercase identifier")
        return value

    @field_validator("source")
    @classmethod
    def valid_source(cls, value: str) -> str:
        if not PATH_RE.fullmatch(value):
            raise ValueError("source must be a dotted object path")
        return value

    @model_validator(mode="after")
    def consistent_rules(self) -> AttributeRule:
        if self.kind != "number" and self.direction != "none":
            raise ValueError("only numeric attributes can have a comparison direction")
        for rule in self.filters:
            if rule.operator in ("min", "max") and self.kind != "number":
                raise ValueError("min/max filters require a numeric attribute")
            if rule.operator == "contains" and self.kind not in ("text", "enum"):
                raise ValueError("contains filters require a text or enum attribute")
        if self.input_units and (self.kind != "number" or not self.unit):
            raise ValueError("input_units require a numeric attribute and canonical unit")
        if any(not unit or not math.isfinite(factor) or factor <= 0 for unit, factor in self.input_units.items()):
            raise ValueError("unit conversion factors must be positive and finite")
        return self


class SearchAlias(BaseModel):
    model_config = ConfigDict(extra="forbid")

    phrase: str = Field(min_length=2, max_length=80)
    parameter: str
    value: str | float | bool

    @field_validator("phrase")
    @classmethod
    def safe_phrase(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z][A-Za-z -]*", value):
            raise ValueError("search alias must contain only words and spaces")
        return value


class CatalogManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    category_slug: str
    display_name: str = Field(min_length=1, max_length=80)
    singular_name: str = Field(min_length=1, max_length=80)
    currency: str = Field(min_length=3, max_length=3)
    field_map: dict[str, str]
    attributes: list[AttributeRule]
    comparison_fields: list[str]
    search_fields: list[str]
    variant_group_source: str | None = None
    variant_value_source: str | None = None
    search_aliases: list[SearchAlias] = Field(default_factory=list)
    guide_questions: list[str] = Field(default_factory=list)
    presentation: Literal["umbrella_demo", "generic"] = "generic"
    source_sha256: str = ""
    preprocessing: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def valid_manifest(self) -> CatalogManifest:
        problems = manifest_problems(self.model_dump(mode="json"))
        if problems:
            raise ValueError("; ".join(problems))
        return self


def manifest_problems(data: dict) -> list[str]:
    """Every cross-field problem in a manifest. Tolerates malformed input, so a reviewer
    sees these even when field-level validation also failed."""
    problems: list[str] = []

    def dicts(value: Any) -> list[dict]:
        return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []

    def strings(value: Any) -> list[str]:
        return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []

    slug = data.get("category_slug")
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        problems.append("category_slug must be a lowercase slug")
    if data.get("presentation") == "umbrella_demo" and slug != "umbrella":
        problems.append("umbrella_demo presentation is reserved for the original demo")
    if not isinstance(data.get("currency"), str) or not re.fullmatch(r"[A-Z]{3}", data["currency"]):
        problems.append("currency must be a three-letter ISO code")
    field_map = data.get("field_map") if isinstance(data.get("field_map"), dict) else {}
    if not REQUIRED_FIELDS.issubset(field_map):
        problems.append(f"field_map must include {sorted(REQUIRED_FIELDS)}; missing {sorted(REQUIRED_FIELDS - set(field_map))}")
    unsupported = sorted(set(field_map) - REQUIRED_FIELDS - OPTIONAL_FIELDS)
    if unsupported:
        problems.append(f"field_map contains an unsupported core field: {unsupported}")
    bad_paths = sorted(str(path) for path in field_map.values() if not isinstance(path, str) or not PATH_RE.fullmatch(path))
    if bad_paths:
        problems.append(f"field_map paths must be dotted object paths: {bad_paths}")
    for name in ("variant_group_source", "variant_value_source"):
        path = data.get(name)
        if path is not None and (not isinstance(path, str) or not PATH_RE.fullmatch(path)):
            problems.append(f"variant paths must be dotted object paths: {name}")
    attributes = dicts(data.get("attributes"))
    keys = [attribute["key"] for attribute in attributes if isinstance(attribute.get("key"), str)]
    if len(keys) != len(set(keys)):
        problems.append("attribute keys must be unique")
    shadowing = sorted(set(keys) & (REQUIRED_FIELDS | OPTIONAL_FIELDS | {"attributes", "variant_group", "variant_value"}))
    if shadowing:
        problems.append(f"attribute keys cannot shadow product fields: {shadowing}")
    parameters = [rule["parameter"] for attribute in attributes for rule in dicts(attribute.get("filters"))
                  if isinstance(rule.get("parameter"), str)]
    if len(parameters) != len(set(parameters)):
        problems.append("filter parameters must be unique")
    builtin = sorted(set(parameters) & {"query", "max_price", "sort_by", "brand", "color", "min_rating"})
    if builtin:
        problems.append(f"filter parameters cannot shadow built-in search fields: {builtin}")
    comparison_fields = strings(data.get("comparison_fields"))
    search_fields = strings(data.get("search_fields"))
    if len(comparison_fields) != len(set(comparison_fields)):
        problems.append("comparison_fields must be unique")
    if len(search_fields) != len(set(search_fields)):
        problems.append("search_fields must be unique")
    unknown = sorted(set(comparison_fields) - {"price", "rating", "brand", "color", "pros", "cons", *keys})
    if not comparison_fields or unknown:
        problems.append(f"comparison_fields contains an unknown field: {unknown}")
    noncomparable = {attribute.get("key") for attribute in attributes if attribute.get("compare") is False}
    if set(comparison_fields) & noncomparable:
        problems.append(f"comparison_fields includes a noncomparable attribute: {sorted(set(comparison_fields) & noncomparable)}")
    unknown = sorted(set(search_fields) - {"name", "description", "brand", "color", *keys})
    if not search_fields or unknown:
        problems.append(f"search_fields contains an unknown field: {unknown}")
    for alias in dicts(data.get("search_aliases")):
        if alias.get("parameter") not in parameters:
            problems.append(f"search alias targets unknown filter {alias.get('parameter')}")
    return problems


class Product(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=1000)
    price: float = Field(gt=0)
    currency: str
    image_url: str = Field(max_length=2000)
    attributes: dict[str, str | float | bool]
    brand: str = Field(default="", max_length=80)
    rating: float | None = Field(default=None, ge=0, le=5)
    review_count: int = Field(default=0, ge=0)
    reviews: list[dict] = Field(default_factory=list)
    pros: list[str] = Field(default_factory=list)
    cons: list[str] = Field(default_factory=list)
    reviews_summary: str = ""
    variant_group: str | None = None
    variant_value: str | None = None
    source_ref: int | None = None
    color: str | None = None
    color_family: str | None = None
    model: str | None = None
    specs: dict | None = None

    @field_validator("id")
    @classmethod
    def safe_id(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError("product id must contain only letters, digits, hyphens, or underscores")
        return value

    @field_validator("image_url")
    @classmethod
    def safe_image_url(cls, value: str) -> str:
        if re.fullmatch(r"/img/[A-Za-z0-9._/-]+", value) and ".." not in value:
            return value
        parsed = urlparse(value)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or any(char in value for char in ('"', "'", "`", "\\", "<", ">")):
            raise ValueError("image_url must be HTTP(S) or a local /img/ path")
        return value

    @field_validator("price")
    @classmethod
    def finite_price(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("price must be finite")
        return value


def normalize_catalog(raw: list[dict] | dict, manifest: CatalogManifest) -> list[dict]:
    records = raw.get("products") if isinstance(raw, dict) else raw
    if not isinstance(records, list) or not records:
        raise ValueError("catalog must be a nonempty array or an object with a products array")
    for field, path in manifest.field_map.items():
        if field in REQUIRED_FIELDS and not all(isinstance(record, dict) and get_path(record, path) is not None for record in records):
            raise ValueError(f"required source path {path!r} is missing in at least one product")
    for field, path in manifest.field_map.items():
        if field not in REQUIRED_FIELDS and not any(
            isinstance(record, dict) and get_path(record, path) is not None for record in records
        ):
            raise ValueError(f"optional source path {path!r} is absent from the catalog")
    for path in (manifest.variant_group_source, manifest.variant_value_source):
        if path and not any(isinstance(record, dict) and get_path(record, path) is not None for record in records):
            raise ValueError(f"variant source path {path!r} is absent from the catalog")
    for attribute in manifest.attributes:
        if not any(isinstance(record, dict) and get_path(record, attribute.source) is not None for record in records):
            raise ValueError(f"attribute source {attribute.source!r} is absent from the catalog")

    products = []
    ids = set()
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise TypeError(f"product {index} is not an object")
        fields = {key: get_path(record, path) for key, path in manifest.field_map.items()}
        if fields.get("currency") not in (None, manifest.currency):
            raise ValueError(f"product {index} uses a different currency")
        attrs: dict[str, str | float | bool] = {}
        for attribute in manifest.attributes:
            value = get_path(record, attribute.source)
            if value is None or value == "":
                continue
            if attribute.kind == "number":
                if isinstance(value, bool):
                    raise ValueError(f"product {index} has nonnumeric {attribute.key}")
                if isinstance(value, str):
                    match = re.fullmatch(r"\s*([+-]?\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*", value)
                    if match:
                        number, source_unit = match.groups()
                        if source_unit not in attribute.input_units:
                            raise ValueError(f"product {index} has unsupported unit {source_unit!r} for {attribute.key}")
                        value = float(number) * attribute.input_units[source_unit]
                    else:
                        value = float(value)
                else:
                    value = float(value)
                if not math.isfinite(value):
                    raise ValueError(f"product {index} has non-finite {attribute.key}")
            elif attribute.kind == "boolean":
                if not isinstance(value, bool):
                    raise ValueError(f"product {index} has nonboolean {attribute.key}")
            elif not isinstance(value, str):
                raise ValueError(f"product {index} has nontext {attribute.key}")
            attrs[attribute.key] = value
        fields.pop("currency", None)
        fields = {key: value for key, value in fields.items() if value is not None}
        fields["id"] = str(fields["id"])
        fields["currency"] = manifest.currency
        fields["attributes"] = attrs
        fields["variant_group"] = get_path(record, manifest.variant_group_source) if manifest.variant_group_source else None
        fields["variant_value"] = get_path(record, manifest.variant_value_source) if manifest.variant_value_source else None
        fields["source_ref"] = index
        try:
            product = Product.model_validate(fields)
        except ValidationError as error:
            detail = "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in error.errors())
            raise ValueError(f"product {index} (id {fields.get('id')!r}): {detail}") from None
        if product.id in ids:
            raise ValueError(f"duplicate product ID {product.id!r}")
        ids.add(product.id)
        normalized = product.model_dump(mode="json")
        if normalized["review_count"] == 0 and normalized["reviews"]:
            normalized["review_count"] = len(normalized["reviews"])
        products.append(normalized)
    return products


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as tmp:
        temp_path = Path(tmp.name)
        json.dump(value, tmp, ensure_ascii=False, indent=2)
        tmp.write("\n")
        tmp.flush()
        os.fsync(tmp.fileno())
    os.replace(temp_path, path)


def publish_catalog(manifest: CatalogManifest, products: list[dict], *, activate: bool = True, base: Path = CATALOG_DIR) -> str:
    """Publish one immutable bundle, then atomically move the active pointer."""
    validated = [Product.model_validate(p).model_dump(mode="json") for p in products]
    if len({p["id"] for p in validated}) != len(validated):
        raise ValueError("duplicate product IDs")
    manifest_data = manifest.model_dump(mode="json")
    version = hashlib.sha256(canonical([manifest_data, validated])).hexdigest()[:16]
    category_dir = base / manifest.category_slug
    bundle_dir = category_dir / version
    with _publish_lock:
        if not bundle_dir.exists():
            bundle_dir.mkdir(parents=True)
            _atomic_json(bundle_dir / "manifest.json", manifest_data)
            _atomic_json(bundle_dir / "products.json", validated)
        # A previous interrupted write must never become the active catalog.
        load_catalog(manifest.category_slug, version, base=base)
        if activate:
            _atomic_json(category_dir / "active.json", {"version": version})
    return version


def load_catalog(slug: str, version: str | None = None, *, base: Path = CATALOG_DIR) -> dict:
    if not SLUG_RE.fullmatch(slug):
        raise ValueError("invalid category slug")
    category_dir = base / slug
    if version is None:
        with (category_dir / "active.json").open(encoding="utf-8") as file:
            version = json.load(file)["version"]
    if not re.fullmatch(r"[0-9a-f]{16}", version):
        raise ValueError("invalid catalog version")
    bundle_dir = category_dir / version
    with (bundle_dir / "manifest.json").open(encoding="utf-8") as file:
        manifest = CatalogManifest.model_validate(json.load(file))
    with (bundle_dir / "products.json").open(encoding="utf-8") as file:
        products = json.load(file)
    if hashlib.sha256(canonical([manifest.model_dump(mode="json"), products])).hexdigest()[:16] != version:
        raise ValueError("catalog bundle checksum mismatch")
    return {"version": version, "manifest": manifest.model_dump(mode="json"), "products": products}
