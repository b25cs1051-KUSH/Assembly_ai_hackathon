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

The existing video and umbrella site show the polished original journey. For a live generalization proof, run the same code with `ACTIVE_CATALOG=dry_fruits`; search almonds under 20 dollars, compare the first two, inspect pack weight/origin/protein, add one to cart, and show checkout. Call checkout an in-browser simulation. The admin plus icon adds manual listings to the active category; it is outside the voice tool set.

## Evidence in the repository

- `frontend/js/voice_agent.js`: fixed category-neutral `SYSTEM_PROMPT`.
- `frontend/js/agent_tools.js`: eight manifest-driven tool definitions and handlers.
- `backend/services/catalog_onboarding.py`: one-time structured preprocessing.
- `data/catalogs/umbrella/` and `data/catalogs/dry_fruits/`: versioned validated bundles.
- `tests/test_catalog.py` and `scripts/test_agent_tools.js`: two-category checks.
