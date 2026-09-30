# Roadmap: VoiceCart for any store

VoiceCart's goal is simple: any online store with good product data lets its shoppers search, compare, ask about reviews and check out by voice. The live demo is an umbrella store. The [`any-store-onboarding`](https://github.com/b25cs1051-KUSH/Assembly_ai_hackathon/tree/any-store-onboarding) branch runs the same storefront, eight voice tools and AssemblyAI voice session on any store's catalog.

## Built

- **A voice shopping agent that drives the whole page** (this branch, live): the Voice Agent API with eight client-side tools, barge-in, keyterms, tuned turn detection and visit memory.
- **One engine for every catalog** (`any-store-onboarding`): filters, product details, comparison rows and tool definitions come from the catalog's manifest. The system prompt names no product category.
- **Onboarding on the AssemblyAI LLM Gateway** (`any-store-onboarding`): the model proposes field mappings, attribute types and units, filters and comparison directions once per catalog, never while a shopper is talking. Validation checks the proposal, and the model gets any errors back to fix.
- **Review before anything goes live** (`any-store-onboarding`): each proposal comes with a review report, and only an explicit approval publishes it. Published catalogs are versioned and checksummed.
- **Two product categories under test** (`any-store-onboarding`): search, comparison, cart and checkout run on the umbrella catalog and on a second category.

How a store onboards today: [INTEGRATION.md](https://github.com/b25cs1051-KUSH/Assembly_ai_hackathon/blob/any-store-onboarding/docs/INTEGRATION.md).

## Next

1. **Import from common e-commerce exports**, starting with Shopify and WooCommerce product exports, so a store connects its existing data as it is.
2. **A merchant review screen in the browser**, so a store owner checks and approves a proposal without the command line.
3. **Larger LLM Gateway models** for onboarding, measured against the same umbrella benchmark.
4. **Multiple stores per deployment**, with each voice session scoped to one store's catalog.
5. **Hosted catalog storage** in place of JSON files on the server.
6. **Real checkout**: payment, inventory and order systems. Checkout is a simulation today.
7. **A drop-in widget**, so any existing storefront can add the voice agent with one script tag.
