# Category-general VoiceCart: implementation plan

Status on branch `feat/admin-catalog`: steps 1 to 6 and 8 are implemented. Step 7 is partly done: the automated two-category checks pass, but a full spoken journey on a second category has not been recorded. The umbrella catalog is the only presented store; the second category is the dry-fruit test fixture in `tests/fixtures/`. How a store uses the result: [INTEGRATION.md](INTEGRATION.md).

## Target behavior

A store owner supplies a JSON catalog for a product category, such as `dry-fruits.json`. A separate LLM analyzes that catalog **during onboarding**, before customers start voice sessions. Its output determines which catalog fields appear in search, product details, filters, and comparisons. It also proposes whether a higher or lower value is preferable for each comparable field, with a confidence score; a very low-confidence preference is omitted. The running storefront uses the resulting, validated category configuration. The LLM is not called for each shopper request.

All categories retain the same eight shopping operations: `search_products`, `show_product`, `compare_products`, `update_compare`, `update_cart`, `show_cart`, `checkout`, and `place_order`. The AssemblyAI token, WebSocket, audio, turn handling, and tool-call/result flow remain shared. One product-neutral system prompt applies to every category; category facts reach the agent through tool definitions and tool results, not through facts embedded in that prompt.

The initial implementation should support **one active catalog per storefront deployment**. A second category can be served by another configured storefront using the same code. Selecting among categories within one live storefront is a later routing option, not a prerequisite for proving the reusable engine. Keep the current umbrella catalog as a regression and judge demo.

## Current code to account for

This section describes the code before the refactor. The line links point at that older code.

- [`frontend/js/voice_agent.js`](../frontend/js/voice_agent.js#L44) contains the umbrella-specific system prompt and greeting. It sends `SYSTEM_PROMPT`, `AgentTools.definitions()`, and `AgentTools.keyterms()` in `session.update` at [line 181](../frontend/js/voice_agent.js#L181); tool calls run through `AgentTools.run()` at [line 338](../frontend/js/voice_agent.js#L338). Its return greeting, spoken-position parsing, and judge guide also contain umbrella examples.
- [`frontend/js/agent_tools.js`](../frontend/js/agent_tools.js#L46) defines the eight tools and their handlers. Search parameters, query cleanup, product summaries, detail data, comparison data, errors, acknowledgement matching, and key terms include umbrella-specific logic. Tools read `App.getProducts()` and use `App.setFilters()`; they do not directly query the JSON file.
- [`frontend/js/app.js`](../frontend/js/app.js#L57) loads `/api/products` into browser state. Filters and sorters assume `specs.wind_rating_mph`, `specs.weight_oz`, `specs.automatic_open`, color, and frame material at [lines 19–39](../frontend/js/app.js#L19) and [100–120](../frontend/js/app.js#L100).
- The voice tool currently constructs its own comparison result in [`agent_tools.js`](../frontend/js/agent_tools.js#L283), while the visible comparison calls a backend endpoint from [`app.js`](../frontend/js/app.js#L170). The backend's row list is fixed in [`backend/services/product_service.py`](../backend/services/product_service.py#L69), and the renderer's “better” directions are fixed in [`frontend/js/ui_renderer.js`](../frontend/js/ui_renderer.js#L167). These paths must agree for the agent's answer to match the screen.
- [`frontend/js/ui_renderer.js`](../frontend/js/ui_renderer.js#L17) renders cards, detail specs, and comparisons using umbrella-oriented fields and fixed currency/review assumptions. [`frontend/index.html`](../frontend/index.html#L353) contains fixed filter controls and loads `agent_tools.js` before `voice_agent.js`.
- [`backend/services/product_service.py`](../backend/services/product_service.py#L9) reads one fixed `data/products.json`. [`backend/main.py`](../backend/main.py#L33) serves that catalog, while its add-product model at [line 59](../backend/main.py#L59) and [`frontend/js/admin.js`](../frontend/js/admin.js#L40) require umbrella attributes.
- Checkout currently calculates a fixed 8% tax and produces an in-browser order number in [`app.js`](../frontend/js/app.js#L235) and [line 277](../frontend/js/app.js#L277). This plan preserves that demo behavior; it does not add payment processing.

## Proposed data contract

Do not require incoming catalogs to have umbrella field names. Onboarding accepts a JSON array or a documented wrapper containing product records, then produces two versioned artifacts:

1. **Normalized catalog:** each product has a stable string `id`, `name`, `description`, `price`, `currency`, `image_url`, and typed `attributes`. Optional data includes brand, variants, rating, reviews, pros, and cons. Keep a reference to the source record for traceability. Reject records missing fields needed for the existing shopping flow; do not invent prices, images, reviews, or specifications.
2. **Category manifest:** store/category display name; source-file hash and version; mappings from source paths to normalized fields; attribute keys, types, units, and labels; text-search fields; eligible filter operators; detail sections; comparison order and formatting; and proposed comparison preference (`higher`, `lower`, or no highlight) with confidence and rationale. The manifest may also supply category-specific tool descriptions, speech key terms, storefront labels, and example questions. It must not supply an alternate system prompt.

For example, a dry-fruit catalog might expose pack weight and origin if those fields actually exist. If products use different weight units, normalization must convert them before filtering or comparison. The preprocessing LLM can propose “lower price per equal quantity is better,” but a deterministic calculation must verify the unit conversion and derived value. Whether higher protein, sugar, or calories is “better” can depend on the shopper's goal; any preference rule needs a recorded rationale and confidence. Below the configured confidence cutoff, retain the attribute for comparison but do not mark a winner. The cutoff should be calibrated on sample catalogs rather than presented as a factual probability.

**Generation rule:** the LLM produces structured data, not executable JavaScript or Python. A schema validator rejects unknown operators, broken source paths, unsupported types, missing required fields, inconsistent units, unsupported comparison formulas, and invalid tool descriptions. The published catalog and manifest form one immutable version so a voice session cannot use definitions from one version and products from another. Any LLM suggestion rejected by validation returns a clear onboarding error for correction or regeneration.

## Implementation sequence

### 1. Define and validate the category manifest

**Status: done.** `backend/services/catalog.py` holds the Product and CatalogManifest models, normalization and unit conversion. Umbrella data and the dry-fruit fixture both validate, and broken paths, units, operators and duplicate IDs are rejected (`tests/test_catalog.py`).

**Add:** a Pydantic model for normalized products and the manifest, plus a validator/normalizer in `backend/services/` (new files). Define a small allowlist of attribute types (`text`, `number`, `boolean`, `enum`) and filter operators (`contains`, `equals`, `min`, `max`). Define comparison direction and display formatting separately from raw values. Specify required product fields and behavior when an optional field is absent.

**Keep compatible:** transform the existing umbrella data into this contract, preserving IDs and review content. Use umbrella attributes to prove the manifest can reproduce the current search and comparison behavior. A product category does not need dummy wind, canopy, or color fields.

**Done when:** umbrella data and a deliberately different sample catalog both pass validation, and invalid/missing source fields fail before publishing.

### 2. Build the one-time LLM preprocessing command

**Status: done, with a review step added.** The command is `python -m backend.services.catalog_onboarding`. The hosted provider is the AssemblyAI LLM Gateway (`qwen3.5-4b-32k-fast`, the gateway model our account can call), and `--provider command` runs a local model. The LLM output is saved as a proposal with a review report, and only `--approve <proposal-id>` publishes it. The manifest records provider, model, prompt version, source hash, validation result and rejected fields. A real run on the umbrella catalog was rejected by validation: [umbrella-llm-vs-reviewed.md](onboarding/umbrella-llm-vs-reviewed.md).

**Add:** an onboarding service and a command such as `scripts/onboard_catalog.py` that takes an input JSON path, desired category name, and output directory. It samples or chunks the catalog when necessary, sends the field inventory and representative records to a configurable LLM provider, and requests structured manifest output. Record the provider/model identifier, prompt version, catalog hash, generated manifest, validation result, and any rejected fields so the result is reproducible.

Use a hosted LLM API for the first hackathon implementation because the repository already uses backend HTTP requests and has no local-model runtime. Keep a provider interface so a local model can replace the API later without changing the manifest or storefront. This is an implementation recommendation, not a requirement of the voice pipeline.

**LLM task:** propose field mappings, search/filter/detail/comparison fields, labels, units, comparison direction, confidence, and rationale. The LLM must choose direction when sufficiently confident and omit only very low-confidence judgments. It must not fabricate absent catalog values, write application code, or silently convert incompatible units.

**Done when:** onboarding a dry-fruit fixture produces a validated manifest and normalized catalog without a customer-facing LLM call; rerunning unchanged input yields an identifiable version and does not silently overwrite the active version.

### 3. Load an active catalog and manifest together

**Status: done.** `ACTIVE_CATALOG` and `CATALOG_ROOT` select the bundle, and `GET /api/catalog` returns manifest, products and version together.

**Change:** [`backend/services/product_service.py`](../backend/services/product_service.py#L9) to load the configured catalog version instead of the one fixed file, and use the manifest for data-dependent behavior. Add an endpoint in [`backend/main.py`](../backend/main.py#L33) to return the active category metadata needed by the browser; keep `/api/products` and the product-detail endpoint as the storefront-facing catalog interface. The existing umbrella deployment should select its umbrella manifest by default.

**Deployment choice:** configure one active category/version per site initially. A future multi-category site may add a store/category route or slug, but must scope **every** catalog read, compare request, and voice session to the same selected version. Do not rely on filenames supplied directly by browser requests.

**Done when:** switching deployment configuration changes the catalog and metadata together while the API paths and voice transport remain stable.

### 4. Refactor the eight tools around the manifest

**Status: done.** `scripts/test_agent_tools.js` runs the same eight tools on the umbrella catalog and the dry-fruit fixture.

**Change:** [`frontend/js/agent_tools.js`](../frontend/js/agent_tools.js#L46) into a shared tool engine fed by the active manifest and normalized catalog. Keep the eight existing tool names and the public interface `definitions`, `keyterms`, `run`, `ackFor`, and `latestResults`, because [`voice_agent.js`](../frontend/js/voice_agent.js#L187) calls those methods directly. Category-specific definitions should describe only valid filters and attributes. Brand/product-ID values may come from the active catalog, but avoid sending an unbounded ID enum when catalogs grow; handlers must still validate IDs and spoken result positions.

**Search/detail:** replace umbrella filler words, wind/weight heuristics, hardcoded color variants, result summaries, and errors with manifest-driven searchable fields and typed filters. Return only attributes present on the relevant product. Variants should follow a declared grouping/variant key rather than assuming all matching `model` values are color variants.

**Compare:** resolve positions or IDs as now, then get the same comparison payload the screen uses. Since the tool runner already supports asynchronous handlers, make `compare_products` await the comparison result before returning it to AssemblyAI. Include labels, values, units, and preference metadata in that result, so the agent can explain a comparison without guessing. Keep the current 2–3 item limit unless the UI is deliberately redesigned.

**Cart/checkout:** keep the operations and confirmation requirement; use normalized product identity, price, and currency. Do not let a generated tool definition claim payment or fulfillment that the existing application does not perform.

**Done when:** the same eight tool names support the umbrella and dry-fruit fixtures, and every attribute stated by a tool is backed by the active catalog or an explicitly validated derived value.

### 5. Make filters, details, and comparisons use the same metadata

**Status: done.** Filters, cards, details and the backend comparison matrix come from the manifest. Serving the dry-fruit fixture showed its own filters (pack weight, origin, protein, roasted) and no umbrella text on the visible page.

**Change:** [`frontend/js/app.js`](../frontend/js/app.js#L19) to build visible filters and search/sort rules from category metadata instead of wind/weight/auto-open constants. Keep the browser catalog state and existing layout, but remove assumptions that every product has color, frame material, reviews, or the same numeric specs. Build the relevant controls in [`frontend/index.html`](../frontend/index.html#L353) and [`frontend/js/ui_renderer.js`](../frontend/js/ui_renderer.js#L62) from the manifest; render missing optional attributes as absent rather than as zero or fabricated text.

**Single comparison source:** update [`backend/services/product_service.py`](../backend/services/product_service.py#L69) to generate the matrix from the manifest. Make the backend result drive both [`UI.renderCompare`](../frontend/js/ui_renderer.js#L150) and the `compare_products` tool result. Replace the renderer's fixed `BETTER` map and first-number parsing with typed values and preference metadata, so it does not mistake package size or a number inside text for the value to rank.

**Admin:** if the existing add-product panel remains available on category sites, change [`frontend/js/admin.js`](../frontend/js/admin.js#L40), the form in `frontend/index.html`, and [`backend/main.py`](../backend/main.py#L59) to accept the active category's required fields and validate them against the manifest. Otherwise disable listing for categories that have not yet been given a valid entry form; never submit umbrella-only fields as placeholders.

**Done when:** changing the active catalog updates filters, details, comparison rows, and the tool's spoken facts consistently, without changing the page's overall structure.

### 6. Make the voice session category-neutral

**Status: done.** One fixed `SYSTEM_PROMPT` names no product category, and a test checks this. A live Voice Agent session on the umbrella catalog ran with the new prompt.

**Change:** [`frontend/js/voice_agent.js`](../frontend/js/voice_agent.js#L44) to use one fixed, generic system prompt. It should specify the eight tool workflows, require the agent to ground product facts in tool results, explain result positions and order confirmation, and avoid product names/specifications/examples tied to any category. Keep category descriptions and factual data in the tool definitions/results. Make the greeting, return greeting, key terms, guide text, and spoken-position parser use active store metadata or neutral wording; these have umbrella-specific strings beyond `SYSTEM_PROMPT` at [line 62](../frontend/js/voice_agent.js#L62), [line 429](../frontend/js/voice_agent.js#L429), and [lines 619–660](../frontend/js/voice_agent.js#L619).

Ensure the catalog and manifest load **before** the voice session sends `session.update`, because the current definitions are built when the socket opens. If the published catalog/version changes during a session, keep that session on its original version or explicitly restart it with a fresh configuration.

**Done when:** the exact same system-prompt text is sent for umbrella and dry-fruit sessions, while their tool definitions and results reflect the correct catalog. Microphone, playback, interruption, and temporary-token behavior still work.

### 7. Verify the claim with two categories

**Status: partly done.** The automated checks listed here pass for both catalogs. The browser/voice journey has been run on the umbrella catalog only.

**Add focused tests** for schema validation, source mapping, unit conversion, comparison direction/confidence handling, absent fields, ID/position resolution, filter semantics, and a prompt-invariance assertion. Compare the agent tool result with the screen's comparison payload for the same IDs. Check that rejected LLM output cannot become a live manifest or executable code.

**Run browser/voice journeys** for the original umbrella catalog and one substantially different catalog: search by a category attribute and price, open details, compare two products, update a comparison, change cart quantities, view cart, enter checkout, and confirm the simulated order. Verify that no umbrella wording or fields appear on the other category's page or in spoken answers. Preserve the umbrella demo path used by judges.

**Done when:** both categories complete the same eight-operation journey; the prompt is byte-for-byte invariant; screen and spoken comparisons agree; and the original umbrella walkthrough still behaves as before.

### 8. Document and present the result accurately

**Status: done.** See `README.md`, `docs/ARCHITECTURE.md` and `docs/INTEGRATION.md`.

Update `README.md` and `docs/ARCHITECTURE.md` with the catalog input contract, onboarding command, manifest format, provider configuration, version-selection procedure, confidence policy, and how to reproduce both category demos. Update the pitch materials to show **catalog → one-time LLM preprocessing → validated manifest → shared storefront/tools → AssemblyAI voice session**. Explain that checkout remains a demonstration until real order and payment systems are added.

## Effort and risk

This is a **medium-to-large refactor of the catalog and storefront**, with a small change to the AssemblyAI transport. A reasonable planning estimate is roughly **8–14 engineer-days** for one engineer to build and test the first two-category prototype, assuming usable sample catalogs, access to a preprocessing LLM, and no real payment integration. The first category consumes most of the work because the current filter, compare, detail, and admin paths are coupled to umbrellas. After the manifest engine is proven, onboarding an additional well-formed category should mainly involve input cleanup, LLM generation, validation, and a category-specific walkthrough; highly inconsistent source data will take longer. These are estimates, not measurements from the repository.

The principal risks are: (1) an arbitrary catalog lacks required commerce fields; (2) the LLM misidentifies units, variants, or “better” direction; (3) generated tool facts differ from the on-screen comparison; (4) category data changes after tool definitions were sent; and (5) a new category appears functional while checkout still represents only a simulated sale. The validation/version gates and two-category acceptance checks above address the first four. Keep the last limitation explicit in the demo and documentation.
