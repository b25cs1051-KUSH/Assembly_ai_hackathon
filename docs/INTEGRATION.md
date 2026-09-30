# Make your store VoiceCart-powered

VoiceCart runs a voice shopping assistant on one store's product catalog. The storefront, the eight voice tools and the AssemblyAI voice session are the same for every store. Only the catalog and its manifest change. This page explains what data a store provides and how the catalog goes live.

## 1. The data contract

A catalog is a JSON file holding either an array of product objects or an object with a `products` array. Your field names can differ from ours: onboarding maps your paths (for example `sku` or `media.main_image`) onto the fields below.

Required in every record:

| Field | Rule |
|---|---|
| `id` | Unique. Letters, digits, `-` or `_` only. |
| `name` | 1 to 120 characters. |
| `description` | 1 to 1000 characters. |
| `price` | Positive, finite number. |
| `currency` | One three-letter ISO code (such as `USD`) for the whole catalog. Records may carry it; any record that does must match. |
| `image_url` | An `http(s)` URL or a local `/img/` path. |

Optional:

| Field | Use |
|---|---|
| `brand` | Spoken when introducing results; filterable. |
| `rating`, `review_count` | Rating from 0 to 5. |
| `reviews`, `reviews_summary`, `pros`, `cons` | What the agent reads back when asked "what do people say?". |
| Variants | Two paths: one that groups variants of the same product (such as `model`) and one that names the option (such as `color` or `size`). |
| Attributes | Any other recorded facts, such as weight, size or material. Each gets a type (`number`, `text`, `boolean`, `enum`). Numbers get a unit, and values written with a unit suffix (`"0.5 kg"`) are converted with declared factors. |

Example record:

```json
{
  "sku": "TR-40-BLK",
  "title": "Trail Daypack 40 L - Black",
  "about": "A 40 litre hiking daypack with a padded hip belt and rain cover.",
  "price_usd": 89.0,
  "photo": "https://example.com/img/tr-40-black.jpg",
  "maker": "Northline",
  "rating": 4.5,
  "model": "Trail Daypack 40 L",
  "color": "Black",
  "specs": { "volume": "40 L", "weight": "1.1 kg", "hip_belt": true }
}
```

## 2. The four steps

1. **Prepare the product JSON.** Export your catalog with the required fields filled for every product.
2. **Run onboarding.** The AssemblyAI LLM Gateway reads a field inventory and up to four sample records and proposes the category configuration: field mappings, attribute types and units, filters, comparison directions with a confidence and a rationale, search aliases and variant paths. This happens once per catalog, never while a shopper is talking.
   ```bash
   python -m backend.services.catalog_onboarding path/to/catalog.json --category my_category
   ```
   The result is a proposal in `data/proposals/<proposal-id>/`. The live catalog is not touched.
3. **Review the report and approve.** Onboarding writes `docs/onboarding/<category>-review.md`. It lists every field mapping with how many records have a value, every attribute's type, unit, filters, comparison direction, confidence and rationale, everything validation rejected, and the product count. A person checks it and approves:
   ```bash
   python -m backend.services.catalog_onboarding --approve <proposal-id>
   ```
   If the model's reply fails validation, onboarding sends the errors back and asks again, up to two more times, and the report lists each attempt. A "Check these" section flags choices that are valid but often wrong, such as an unmapped source field or an alias that matches no product. Approval is refused if the proposal failed validation or was edited after it was proposed. If the LLM got something wrong, write the manifest by hand and publish it with `--manifest-template path/to/manifest.json`.
4. **Publish.** Approval writes an immutable, checksummed bundle to `data/catalogs/<category>/<version>/` and points the category's `active.json` at it. The same storefront, the eight voice tools (`search_products`, `show_product`, `compare_products`, `update_compare`, `update_cart`, `show_cart`, `checkout`, `place_order`) and the AssemblyAI voice session then run on that catalog. Set `ACTIVE_CATALOG=<category>` for the deployment.

## 3. What validation guarantees, and what it can't

Validation guarantees that:

- every required field is present in every record, and every mapped source path exists in the data
- values have their declared types, numbers are finite, and unit suffixes are ones the manifest declares
- IDs are unique and safe, image URLs are `http(s)` or `/img/`, and the catalog uses one currency
- filter operators fit their attribute types, and tool parameter names are unique and don't clash with built-in ones
- a published bundle matches its checksum, so a partly written or edited bundle is never served
- errors name the exact manifest field (such as `attributes.0.filters.0.operator`) or record (such as `product 1 (id 'DF-ALM-500')`) that failed

Validation can't fix wrong source data. If a price or a spec is wrong in your export, it will be wrong in the store and the agent will say it. Accurate, structured data is the merchant's responsibility. The LLM only proposes mappings. It doesn't correct values, and the review step is there to catch mistakes validation can't detect, such as variants grouped by the wrong field, a missing filter, or an overconfident comparison direction. Our real umbrella run shows each of these: [umbrella-llm-vs-reviewed.md](onboarding/umbrella-llm-vs-reviewed.md).

## 4. Status

| Part | Status |
|---|---|
| Onboarding (LLM Gateway proposal or hand-written manifest) | Built |
| Review report and `--approve` gate | Built |
| Validation and versioned, checksummed publishing | Built |
| The eight voice tools, running on any validated catalog | Built |
| The storefront, driven by the catalog manifest | Built |
| Real payments (checkout is a simulation today) | Planned |
| Inventory sync | Planned |
| Multiple stores per deployment (today: one active catalog) | Planned |
| Hosted catalog storage (today: JSON files on the server) | Planned |
| Import from common e-commerce export formats | Planned |

What comes next, in order: [ROADMAP.md](ROADMAP.md).

## 5. Evidence

- Real LLM Gateway onboarding of the umbrella catalog: the validated proposal ([data/proposals/82c254ff6d22940f/](../data/proposals/82c254ff6d22940f/), [report](onboarding/umbrella-review.md)) matched the reviewed manifest on all 16 core fields and all 5 comparison directions ([field-by-field comparison](onboarding/umbrella-llm-vs-reviewed.md)). An earlier prompt version's proposal shows the approval gate at work: validation stopped it before it could go live ([data/proposals/5e5e2f093a2613eb/](../data/proposals/5e5e2f093a2613eb/), [report](onboarding/umbrella-review-v1.md)).
- [tests/test_catalog.py](../tests/test_catalog.py): validation, versioning, the gateway call (mocked), the proposal and approval gate, and the category-neutral system prompt.
- [scripts/test_agent_tools.js](../scripts/test_agent_tools.js): the eight tools, comparison, cart and checkout on the umbrella catalog and on a second-category test fixture (`tests/fixtures/catalogs/dry_fruits/`).
