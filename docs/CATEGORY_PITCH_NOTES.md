# Category-general VoiceCart pitch update

Use these slide changes alongside the existing umbrella video. The video remains an example storefront, not proof that a merchant has already connected a real checkout.

## Product claim

VoiceCart is a reusable voice shopping storefront for one merchant catalog per deployment. The merchant supplies a JSON catalog. A one-time model call through the AssemblyAI LLM Gateway proposes category field mappings and comparison rules. Validation checks the proposal, a person reviews its report and approves it, and only then is a versioned catalog and manifest published. The same eight shopping tools, storefront structure, and category-neutral AssemblyAI system prompt then run on that catalog.

## Suggested slide sequence

1. **Problem and product:** shoppers ask natural questions; VoiceCart turns them into visible search, details, comparison, cart, and simulated checkout.
2. **Reusable engine:** catalog JSON -> one-time LLM Gateway proposal -> validation and review report -> approval -> versioned manifest and normalized products -> shared storefront and eight tools -> AssemblyAI voice session. The LLM onboarding step is separate from live shopper requests.
3. **Onboarding evidence:** real LLM Gateway runs on the umbrella data (`docs/onboarding/`). The first prompt version was rejected by validation, so the approval gate blocked it. The second passed after the model corrected its own validation errors: 16 of 16 core fields, 5 of 5 attributes and 5 of 5 comparison directions matched the reviewed manifest. The report still left a wrong alias and an invented rationale detail for a reviewer to fix. Tests run a 3-product dry-fruit fixture through the same prompt and tool names.
4. **Grounding and trust:** products come from the active catalog; comparisons use one backend matrix for screen and agent; weak comparison preferences remain visible without a highlighted winner. Invalid mappings/units are rejected before publication.
5. **Business path:** new category onboarding needs accurate, structured source data and a review. Real payments, inventory sync, multiple stores per deployment, hosted catalog storage, and import from common e-commerce export formats are planned, not built.

## Judge demo path

The existing video and umbrella site show the full shopper journey. The umbrella catalog is the only presented store. Show onboarding as a pipeline instead: the committed LLM proposal and review report in `docs/onboarding/`, the approval gate, and the tests that run a second category through the same tools. Call checkout an in-browser simulation. The admin plus icon adds manual listings to the active category; it is outside the voice tool set.

## Evidence in the repository

- `frontend/js/voice_agent.js`: fixed category-neutral `SYSTEM_PROMPT`.
- `frontend/js/agent_tools.js`: eight manifest-driven tool definitions and handlers.
- `backend/services/catalog_onboarding.py`: one-time proposal, review report and approval gate.
- `docs/onboarding/`: the real umbrella onboarding report and its comparison with the reviewed manifest.
- `data/catalogs/umbrella/`: the versioned, validated umbrella bundle. `tests/fixtures/catalogs/dry_fruits/`: a second-category test bundle.
- `tests/test_catalog.py` and `scripts/test_agent_tools.js`: validation, approval gate, prompt and two-category tool checks.

## Corrections to the existing starter deck

The untracked `docs/starter_presentation.pptx` is an earlier concept draft. Its slide copy does not describe the current repository. Use this replacement outline before submitting that deck:

1. **VoiceCart AI:** voice shopping storefront with a reusable catalog engine. The umbrella video is one example deployment.
2. **Shopper flow:** say a need, see matching products, compare recorded attributes, update the cart, and review a simulated checkout.
3. **Live voice path:** browser microphone sends 24 kHz PCM audio directly to AssemblyAI over its Voice Agent WebSocket. FastAPI issues a temporary token and serves catalog/compare APIs; it does not proxy audio.
4. **Turn and playback handling:** AssemblyAI handles speech, the model, and reply audio. Browser worklets capture/play audio and pause output quickly for interruptions.
5. **Agent actions:** AssemblyAI calls eight client-side shopping tools. The browser updates the screen and returns catalog-grounded results. There is no Python intent state machine.
6. **Second-category test:** 15 umbrella records and a 3-item dry-fruit test fixture use the same prompt/tool names. Each has its own validated attribute rules and filters. The umbrella store is the only presented store.
7. **Onboarding architecture:** source JSON, one-time LLM Gateway proposal, Pydantic validation, review report, approval, immutable manifest/product bundle, then shared storefront and voice tools. No Redis or vector search is implemented.
8. **Merchant path:** one active category per deployment; manual category-aware listing panel. Payments, inventory, fulfillment, durable hosted storage, and multi-merchant routing remain integration work.
9. **Evidence and limitations:** cite the onboarding report, the tests and the existing umbrella video. Do not claim sub-300 ms voice replies, 60% faster discovery, millions of SKUs, or thousands of simultaneous sessions; the repository has no supporting measurements for those claims.

The starter deck currently mentions 16 kHz audio, a backend WebSocket proxy, Redis, 22 umbrella products, and unmeasured performance/business percentages. Those are inconsistent with the checked-in implementation and should not appear in the submission.
