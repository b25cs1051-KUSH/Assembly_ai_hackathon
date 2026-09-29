# Category-general VoiceCart pitch update

Use these slide changes alongside the existing umbrella video. The video remains an example storefront, not proof that a merchant has already connected a real checkout.

## Product claim

VoiceCart is a reusable voice shopping storefront for one merchant catalog per deployment. The merchant supplies a JSON catalog. A one-time preprocessing model proposes category field mappings and comparison rules. Validation produces a versioned catalog and manifest. The same eight shopping tools, storefront structure, and category-neutral AssemblyAI system prompt then run on that catalog.

## Suggested slide sequence

1. **Problem and product:** shoppers ask natural questions; VoiceCart turns them into visible search, details, comparison, cart, and simulated checkout.
2. **Reusable engine:** catalog JSON -> one-time LLM preprocessing -> validated manifest and normalized products -> shared storefront and eight tools -> AssemblyAI voice session. The LLM onboarding step is separate from live shopper requests.
3. **Two-category proof:** umbrella demo (15 products) and dry-fruit sample (3 products). Show their different filters and comparison fields while keeping the same voice prompt and tool names.
4. **Grounding and trust:** products come from the active catalog; comparisons use one backend matrix for screen and agent; weak comparison preferences remain visible without a highlighted winner. Invalid mappings/units are rejected before publication.
5. **Business path:** new category onboarding needs a usable source catalog and validation review. Merchant branding, real payments, inventory, fulfillment, durable hosted storage, and multi-merchant routing are future integrations.

## Judge demo path

The existing video and umbrella site show the full shopper journey. The umbrella catalog is the only presented store. Show onboarding as a pipeline instead: the committed LLM proposal and review report in `docs/onboarding/`, the approval gate, and the tests that run a second category through the same tools. Call checkout an in-browser simulation. The admin plus icon adds manual listings to the active category; it is outside the voice tool set.

## Evidence in the repository

- `frontend/js/voice_agent.js`: fixed category-neutral `SYSTEM_PROMPT`.
- `frontend/js/agent_tools.js`: eight manifest-driven tool definitions and handlers.
- `backend/services/catalog_onboarding.py`: one-time structured preprocessing.
- `data/catalogs/umbrella/`: the versioned, validated umbrella bundle. `tests/fixtures/catalogs/dry_fruits/`: a second-category test bundle.
- `tests/test_catalog.py` and `scripts/test_agent_tools.js`: two-category checks.

## Corrections to the existing starter deck

The untracked `docs/starter_presentation.pptx` is an earlier concept draft. Its slide copy does not describe the current repository. Use this replacement outline before submitting that deck:

1. **VoiceCart AI:** voice shopping storefront with a reusable catalog engine. The umbrella video is one example deployment.
2. **Shopper flow:** say a need, see matching products, compare recorded attributes, update the cart, and review a simulated checkout.
3. **Live voice path:** browser microphone sends 24 kHz PCM audio directly to AssemblyAI over its Voice Agent WebSocket. FastAPI issues a temporary token and serves catalog/compare APIs; it does not proxy audio.
4. **Turn and playback handling:** AssemblyAI handles speech, the model, and reply audio. Browser worklets capture/play audio and pause output quickly for interruptions.
5. **Agent actions:** AssemblyAI calls eight client-side shopping tools. The browser updates the screen and returns catalog-grounded results. There is no Python intent state machine.
6. **Two-category proof:** 15 umbrella records and a 3-item dry-fruit fixture use the same prompt/tool names. Each category has its own validated attribute rules and filters.
7. **Onboarding architecture:** source JSON, one-time LLM proposal, Pydantic validation, immutable manifest/product bundle, then shared storefront and voice tools. No Redis or vector search is implemented.
8. **Merchant path:** one active category per deployment; manual category-aware listing panel. Payments, inventory, fulfillment, durable hosted storage, and multi-merchant routing remain integration work.
9. **Evidence and limitations:** cite the two-category tests and the existing umbrella video. Do not claim sub-300 ms voice replies, 60% faster discovery, millions of SKUs, or thousands of simultaneous sessions; the repository has no supporting measurements for those claims.

The starter deck currently mentions 16 kHz audio, a backend WebSocket proxy, Redis, 22 umbrella products, and unmeasured performance/business percentages. Those are inconsistent with the checked-in implementation and should not appear in the submission.
