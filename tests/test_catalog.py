import copy
import hashlib
import json
import re
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend import config
from backend.main import app
from backend.services import catalog_onboarding, product_service
from backend.services.catalog import (
    CatalogManifest,
    load_catalog,
    normalize_catalog,
    publish_catalog,
)
from backend.services.catalog_onboarding import (
    approve,
    check_proposal,
    onboard,
    propose,
    propose_manifest,
    review_hints,
)

ROOT = Path(__file__).resolve().parents[1]
FRUIT_SOURCE = ROOT / "tests/fixtures/dry_fruits.sample.json"
FRUIT_TEMPLATE = ROOT / "tests/fixtures/dry_fruits_manifest.template.json"


def fixture(category):
    if category == "umbrella":
        source = ROOT / "data/products.json"
        template = ROOT / "data/umbrella_manifest.template.json"
    else:
        source = ROOT / "tests/fixtures/dry_fruits.sample.json"
        template = ROOT / "tests/fixtures/dry_fruits_manifest.template.json"
    return json.loads(source.read_text(encoding="utf-8")), CatalogManifest.model_validate(
        json.loads(template.read_text(encoding="utf-8"))
    )


def test_different_shapes_normalize_without_umbrella_placeholders():
    umbrellas, umbrella_manifest = fixture("umbrella")
    fruits, fruit_manifest = fixture("dry_fruits")
    normalized_umbrellas = normalize_catalog(umbrellas, umbrella_manifest)
    normalized_fruits = normalize_catalog(fruits, fruit_manifest)
    assert len(normalized_umbrellas) == 15
    assert normalized_umbrellas[0]["attributes"]["wind_rating_mph"] == 100
    assert normalized_fruits[1]["attributes"]["pack_weight_g"] == 500
    assert "wind_rating_mph" not in normalized_fruits[0]["attributes"]
    assert normalized_fruits[0]["rating"] is None


def test_invalid_or_invented_source_fields_rejected():
    fruits, manifest = fixture("dry_fruits")
    broken = manifest.model_copy(deep=True)
    broken.attributes[0].source = "properties.not_in_catalog"
    with pytest.raises(ValueError, match="absent"):
        normalize_catalog(fruits, broken)
    broken = copy.deepcopy(fruits)
    broken[1]["properties"]["pack_weight"] = "0.5 stones"
    with pytest.raises(ValueError, match="unsupported unit"):
        normalize_catalog(broken, manifest)
    broken = copy.deepcopy(fruits)
    broken[0]["sku"] = broken[1]["sku"]
    with pytest.raises(ValueError, match="duplicate"):
        normalize_catalog(broken, manifest)
    with pytest.raises(ValueError, match="search alias"):
        CatalogManifest.model_validate({
            **manifest.model_dump(), "search_aliases": [
                {"phrase": ".*", "parameter": "origin", "value": "India"}
            ],
        })
    broken_manifest = manifest.model_copy(deep=True)
    broken_manifest.field_map["brand"] = "missing.brand"
    with pytest.raises(ValueError, match="optional source path"):
        normalize_catalog(fruits, broken_manifest)
    broken_manifest = manifest.model_copy(deep=True)
    broken_manifest.attributes[0].filters[0].operator = "contains"
    with pytest.raises(ValueError, match="contains filters"):
        CatalogManifest.model_validate(broken_manifest.model_dump())
    broken_manifest = manifest.model_copy(deep=True)
    broken_manifest.attributes[0].filters[0].parameter = "max_price"
    with pytest.raises(ValueError, match="built-in"):
        CatalogManifest.model_validate(broken_manifest.model_dump())
    broken_manifest = manifest.model_copy(deep=True)
    broken_manifest.comparison_fields.append("price")
    with pytest.raises(ValueError, match="unique"):
        CatalogManifest.model_validate(broken_manifest.model_dump())


def test_published_versions_are_stable_and_previous_version_remains_readable(tmp_path):
    fruits, manifest = fixture("dry_fruits")
    products = normalize_catalog(fruits, manifest)
    first = publish_catalog(manifest, products, base=tmp_path)
    assert publish_catalog(manifest, products, base=tmp_path) == first
    second = publish_catalog(manifest, [{**products[0], "id": "new"}, *products], base=tmp_path)
    assert first != second
    assert load_catalog("dry_fruits", base=tmp_path)["version"] == second
    assert len(load_catalog("dry_fruits", first, base=tmp_path)["products"]) == 3
    path = tmp_path / "dry_fruits" / second / "products.json"
    path.write_text(path.read_text(encoding="utf-8").replace("new", "changed"), encoding="utf-8")
    with pytest.raises(ValueError, match="checksum"):
        load_catalog("dry_fruits", second, base=tmp_path)


def test_comparison_direction_confidence_and_typed_values(tmp_path, monkeypatch):
    fruits, manifest = fixture("dry_fruits")
    products = normalize_catalog(fruits, manifest)
    version = publish_catalog(manifest, products, base=tmp_path)
    monkeypatch.setenv("CATALOG_ROOT", str(tmp_path))
    monkeypatch.setenv("ACTIVE_CATALOG", "dry_fruits")
    result = product_service.compare_products([products[0]["id"], products[1]["id"]], version)
    rows = {row["key"]: row for row in result["matrix"]}
    assert rows["price"]["best_indexes"] == [0]
    assert rows["pack_weight_g"]["raw_values"] == [250, 500]
    assert rows["pack_weight_g"]["direction"] == "none"
    assert rows["pack_weight_g"]["best_indexes"] == []
    assert rows["protein_g_per_100g"]["best_indexes"] == []
    assert all("wind" not in row["key"] for row in result["matrix"])


def test_api_catalog_compare_and_category_admin_are_versioned(tmp_path, monkeypatch):
    fruits, manifest = fixture("dry_fruits")
    first = publish_catalog(manifest, normalize_catalog(fruits, manifest), base=tmp_path)
    monkeypatch.setenv("CATALOG_ROOT", str(tmp_path))
    monkeypatch.setenv("ACTIVE_CATALOG", "dry_fruits")
    monkeypatch.setattr(config, "ADMIN_PASSWORD", "test-admin-password")
    with TestClient(app) as client:
        catalog = client.get("/api/catalog").json()
        assert catalog["version"] == first
        assert len(client.get("/api/products").json()) == 3
        assert client.post("/api/admin/products", json={"name": "X"}).status_code == 401
        listing = {
            "name": "Pistachios 300 g", "description": "Shelled pistachios",
            "brand": "Harvest Pantry", "price": 12.50,
            "image_url": "https://example.com/pistachios.jpg",
            "attributes": {"pack_weight_g": 300, "origin": "India", "roasted": False},
        }
        response = client.post("/api/admin/products", json=listing,
                               headers={"X-Admin-Password": "test-admin-password"})
        assert response.status_code == 201, response.text
        assert response.json()["catalog_version"] != first
        assert len(client.get("/api/products").json()) == 4
        old = client.post("/api/products/compare",
                          json={"ids": ["DF-ALM-250", "DF-ALM-500"], "version": first})
        assert old.status_code == 200
        assert old.json()["version"] == first
        bad = {**listing, "attributes": {"wind_rating_mph": 100}}
        assert client.post("/api/admin/products", json=bad,
                           headers={"X-Admin-Password": "test-admin-password"}).status_code == 422
        bad = {**listing, "name": "<script>alert(1)</script>"}
        assert client.post("/api/admin/products", json=bad,
                           headers={"X-Admin-Password": "test-admin-password"}).status_code == 422


def test_umbrella_admin_keeps_existing_request_shape(tmp_path, monkeypatch):
    umbrellas, manifest = fixture("umbrella")
    publish_catalog(manifest, normalize_catalog(umbrellas, manifest), base=tmp_path)
    monkeypatch.setenv("CATALOG_ROOT", str(tmp_path))
    monkeypatch.setenv("ACTIVE_CATALOG", "umbrella")
    monkeypatch.setattr(config, "ADMIN_PASSWORD", "test-admin-password")
    original = copy.deepcopy(umbrellas[0])
    original.pop("id")
    original["name"] = "Test umbrella"
    with TestClient(app) as client:
        response = client.post("/api/admin/products", json=original,
                               headers={"X-Admin-Password": "test-admin-password"})
        assert response.status_code == 201, response.text
        assert response.json()["id"] == "16"
        assert response.json()["attributes"]["wind_rating_mph"] == 100


def test_llm_provider_is_onboarding_only_and_output_is_validated(tmp_path, monkeypatch):
    fruits, _ = fixture("dry_fruits")
    template = json.loads((ROOT / "tests/fixtures/dry_fruits_manifest.template.json").read_text(encoding="utf-8"))
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "test-only")
    monkeypatch.setenv("CATALOG_LLM_MODEL", "test-model")

    def fake_gateway(request):
        assert request.url.host == "llm-gateway.assemblyai.com"
        assert request.url.path == "/v1/chat/completions"
        assert request.headers["authorization"] == "test-only"
        sent = json.loads(request.content)
        assert "response_format" not in sent
        assert sent["model"] == "test-model"
        assert sent["messages"][0]["role"] == "system"
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop",
            "message": {"content": "```json\n" + json.dumps(template) + "\n```"}}]})

    with httpx.Client(transport=httpx.MockTransport(fake_gateway)) as client:
        proposal = propose_manifest(fruits, "dry_fruits", client=client)
        assert proposal["category_slug"] == "dry_fruits"
        result = propose(FRUIT_SOURCE, "dry_fruits", client=client,
                         proposals_root=tmp_path / "proposals", report_dir=tmp_path / "docs")
    assert result["status"] == "pending_review"
    assert result["product_count"] == 3
    # Proposing never writes the live catalog.
    assert not (tmp_path / "catalogs").exists()
    folder = tmp_path / "proposals" / result["proposal_id"]
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["preprocessing"] == {
        "provider": "assemblyai", "model": "test-model", "prompt_version": "catalog-manifest-v2",
        "validation": "passed", "rejected_fields": "",
    }
    assert manifest["source_sha256"] == hashlib.sha256(FRUIT_SOURCE.read_bytes()).hexdigest()
    report = (tmp_path / "docs" / "dry_fruits-review.md").read_text(encoding="utf-8")
    assert "pending_review" in report and "Products that would be published: 3" in report
    assert "| pack_weight_g |" in report and "--approve " + result["proposal_id"] in report

    version = approve(result["proposal_id"], proposals_root=tmp_path / "proposals",
                      output_root=tmp_path / "catalogs")
    bundle = load_catalog("dry_fruits", base=tmp_path / "catalogs")
    assert bundle["version"] == version
    assert bundle["manifest"]["preprocessing"]["provider"] == "assemblyai"
    meta = json.loads((folder / "proposal.json").read_text(encoding="utf-8"))
    assert meta["status"] == "approved" and meta["catalog_version"] == version


def gateway_client(content):
    return httpx.Client(transport=httpx.MockTransport(lambda _request: httpx.Response(
        200, json={"choices": [{"finish_reason": "stop", "message": {"content": content}}]})))


def test_rejected_llm_output_is_reported_and_cannot_be_approved(tmp_path, monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "test-only")
    bad_manifest = json.loads(FRUIT_TEMPLATE.read_text(encoding="utf-8"))
    bad_manifest["attributes"][0]["filters"][0]["operator"] = "execute_python"
    with gateway_client(json.dumps(bad_manifest)) as client:
        result = propose(FRUIT_SOURCE, "dry_fruits", client=client,
                         proposals_root=tmp_path / "proposals", report_dir=tmp_path / "docs")
    assert result["status"] == "rejected"
    assert result["product_count"] == 0
    assert any(error.startswith("attributes.0.filters.0.operator:") for error in result["errors"])
    report = (tmp_path / "docs" / "dry_fruits-review.md").read_text(encoding="utf-8")
    assert "attributes.0.filters.0.operator" in report and "cannot be published" in report
    with pytest.raises(ValueError, match=r"attributes\.0\.filters\.0\.operator"):
        approve(result["proposal_id"], proposals_root=tmp_path / "proposals", output_root=tmp_path / "catalogs")
    assert not (tmp_path / "catalogs").exists()


def test_unparseable_reply_and_bad_record_name_the_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "test-only")
    with gateway_client("Here is your manifest!") as client:
        result = propose(FRUIT_SOURCE, "dry_fruits", client=client,
                         proposals_root=tmp_path / "proposals", report_dir=tmp_path / "docs")
    assert result["status"] == "rejected" and result["errors"][0].startswith("LLM reply:")

    fruits = json.loads(FRUIT_SOURCE.read_text(encoding="utf-8"))
    fruits[1]["photo_url"] = "javascript:alert(1)"
    source = tmp_path / "fruits.json"
    source.write_text(json.dumps(fruits), encoding="utf-8")
    with gateway_client(FRUIT_TEMPLATE.read_text(encoding="utf-8")) as client:
        result = propose(source, "dry_fruits", client=client,
                         proposals_root=tmp_path / "proposals", report_dir=tmp_path / "docs")
    assert result["status"] == "rejected"
    assert result["errors"] == [(f"product 1 (id {fruits[1]['sku']!r}): image_url: "
                                 "Value error, image_url must be HTTP(S) or a local /img/ path")]


def test_approval_refuses_unknown_or_edited_proposals(tmp_path, monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "test-only")
    with gateway_client(FRUIT_TEMPLATE.read_text(encoding="utf-8")) as client:
        result = propose(FRUIT_SOURCE, "dry_fruits", client=client,
                         proposals_root=tmp_path / "proposals", report_dir=tmp_path / "docs")
    roots = {"proposals_root": tmp_path / "proposals", "output_root": tmp_path / "catalogs"}
    with pytest.raises(ValueError, match="16 lowercase hex"):
        approve("../../etc", **roots)
    with pytest.raises(FileNotFoundError):
        approve("0" * 16, **roots)
    products = tmp_path / "proposals" / result["proposal_id"] / "products.json"
    edited = json.loads(products.read_text(encoding="utf-8"))
    edited[0]["price"] = 0.01
    products.write_text(json.dumps(edited), encoding="utf-8")
    with pytest.raises(ValueError, match="changed after it was proposed"):
        approve(result["proposal_id"], **roots)
    assert not (tmp_path / "catalogs").exists()


def test_manual_manifest_template_still_publishes_directly(tmp_path):
    version = onboard(FRUIT_SOURCE, "dry_fruits", manifest_template=FRUIT_TEMPLATE, output_root=tmp_path)
    bundle = load_catalog("dry_fruits", base=tmp_path)
    assert bundle["version"] == version
    assert bundle["manifest"]["preprocessing"]["provider"] == "template"
    bad = json.loads(FRUIT_TEMPLATE.read_text(encoding="utf-8"))
    bad["attributes"][0]["filters"][0]["operator"] = "execute_python"
    bad_path = tmp_path / "bad.json"
    bad_path.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValidationError):
        onboard(FRUIT_SOURCE, "dry_fruits", manifest_template=bad_path, output_root=tmp_path / "other")
    assert not (tmp_path / "other").exists()


def test_system_prompt_is_fixed_and_contains_no_category_facts():
    source = (ROOT / "frontend/js/voice_agent.js").read_text(encoding="utf-8")
    prompt = source.split("const SYSTEM_PROMPT = `", 1)[1].split("`;", 1)[0]
    assert "${" not in prompt
    category_words = ("umbrella", "wind", "windproof", "canopy", "rain", "almond", "almonds", "cashew",
                      "nut", "nuts", "dry fruit", "pack weight", "protein", "TUMELLA", "VoiceCart")
    for word in category_words:
        assert not re.search(rf"\b{re.escape(word)}\b", prompt, re.IGNORECASE), word
    assert "search_products" in prompt and "compare_products" in prompt
    for behaviour in ("Round prices", "apologise briefly and correct yourself", "exactly as long as the question needs",
                      "Every position from 1 to total_matches is valid", "by position and brand",
                      "which variants are available", "offer to relax one requirement",
                      "means the second column", "opens checkout in one step", "start your answer with the answer"):
        assert behaviour in prompt, behaviour


def test_gateway_model_defaults_and_truncated_reply_is_rejected(monkeypatch):
    fruits, _ = fixture("dry_fruits")
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "test-only")
    monkeypatch.delenv("CATALOG_LLM_MODEL", raising=False)

    def fake_gateway(request):
        assert json.loads(request.content)["model"] == "qwen3.5-4b-32k-fast"
        return httpx.Response(200, json={"choices": [{"finish_reason": "length",
            "message": {"content": "{"}}]})

    with httpx.Client(transport=httpx.MockTransport(fake_gateway)) as client, \
            pytest.raises(RuntimeError, match="length"):
        propose_manifest(fruits, "dry_fruits", client=client)
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "")
    with pytest.raises(ValueError, match="ASSEMBLYAI_API_KEY"):
        propose_manifest(fruits, "dry_fruits")


def scripted_gateway(replies, seen):
    """Answer each gateway call with the next scripted reply and keep the request bodies."""
    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop",
            "message": {"content": replies[len(seen) - 1]}}]})
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_rejected_attempt_is_sent_back_and_corrected(tmp_path, monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "test-only")
    good = json.loads(FRUIT_TEMPLATE.read_text(encoding="utf-8"))
    bad = {**good, "schema_version": "1"}
    seen = []
    with scripted_gateway([json.dumps(bad), json.dumps(good)], seen) as client:
        result = propose(FRUIT_SOURCE, "dry_fruits", client=client,
                         proposals_root=tmp_path / "proposals", report_dir=tmp_path / "docs")
    assert result["status"] == "pending_review"
    assert [len(a["errors"]) for a in result["attempts"]] == [1, 0]
    retry = seen[1]["messages"]
    assert retry[2] == {"role": "assistant", "content": json.dumps(bad)}
    assert "schema_version: Input should be 1" in retry[3]["content"]
    report = (tmp_path / "docs" / "dry_fruits-review.md").read_text(encoding="utf-8")
    assert "Attempt 1: 1 errors" in report and "Attempt 2: passed validation" in report


def test_retries_stop_after_two_and_stay_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "test-only")
    seen = []
    with scripted_gateway(["not json"] * 3, seen) as client:
        result = propose(FRUIT_SOURCE, "dry_fruits", client=client,
                         proposals_root=tmp_path / "proposals", report_dir=tmp_path / "docs")
    assert len(seen) == 3
    assert result["status"] == "rejected" and len(result["attempts"]) == 3


def test_rate_limited_gateway_call_is_retried(monkeypatch):
    fruits, _ = fixture("dry_fruits")
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "test-only")
    monkeypatch.setattr(catalog_onboarding, "RATE_LIMIT_WAITS", (0, 0))
    calls = []

    def handler(_request):
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(429, json={"error": "rate limited"})
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop",
            "message": {"content": FRUIT_TEMPLATE.read_text(encoding="utf-8")}}]})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert propose_manifest(fruits, "dry_fruits", client=client)["category_slug"] == "dry_fruits"
    assert len(calls) == 3


def test_every_failure_in_the_real_v1_proposal_is_reported_at_once():
    proposed = json.loads((ROOT / "data/proposals/5e5e2f093a2613eb/manifest.json").read_text(encoding="utf-8"))
    raw = json.loads((ROOT / "data/products.json").read_text(encoding="utf-8"))
    products, errors = check_proposal(proposed, raw)
    assert products == []
    joined = "\n".join(errors)
    for failure in ("schema_version", "search_aliases.0", "unsupported core field",
                    "cannot shadow product fields", "search_fields contains an unknown field"):
        assert failure in joined, failure


def test_review_hints_flag_valid_but_doubtful_choices():
    raw = json.loads((ROOT / "data/products.json").read_text(encoding="utf-8"))
    reviewed = json.loads((ROOT / "data/umbrella_manifest.template.json").read_text(encoding="utf-8"))
    doubtful = copy.deepcopy(reviewed)
    doubtful["variant_group_source"] = "id"
    doubtful["attributes"] = [a for a in doubtful["attributes"] if a["key"] != "automatic_open"]
    doubtful["attributes"][1]["confidence"] = 1
    hints = "\n".join(review_hints(doubtful, raw))
    assert "variant_group_source is the product id path" in hints
    assert "`specs.automatic_open` (15 of 15 records) is not mapped" in hints
    assert "confidence 1" in hints
    assert "product id path" not in "\n".join(review_hints(reviewed, raw))
    assert "not mapped" not in "\n".join(review_hints(reviewed, raw))
