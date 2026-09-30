# Roadmap: VoiceCart for any store

VoiceCart's goal is that any online store with good product data can let its shoppers search, compare, ask about reviews and check out by voice. The live demo is an umbrella store. This branch makes the same storefront, eight voice tools and AssemblyAI voice session run on any store's catalog.

## Built

- **One engine for every catalog.** Filters, product details, comparison rows and tool definitions come from the catalog's manifest. The system prompt names no product category.
- **Onboarding on the AssemblyAI LLM Gateway.** The model proposes field mappings, attribute types and units, filters and comparison directions once per catalog, never while a shopper is talking. Validation checks every reply, and the model gets its errors back to correct them.
- **Review before anything goes live.** Each proposal comes with a review report, and only `--approve` publishes it. Published catalogs are versioned and checksummed.
- **Two categories under test.** The eight tools, comparison, cart and checkout run on the umbrella catalog and on a second, dry-fruit test catalog.

How a store onboards today: [INTEGRATION.md](INTEGRATION.md).

## Next

1. **Import from common e-commerce exports**, starting with Shopify and WooCommerce product exports, so a store doesn't have to reshape its data by hand.
2. **A review screen in the browser**, so a merchant can check and approve a proposal without the command line.
3. **Larger LLM Gateway models** for onboarding as they become available on our account, measured against the same umbrella comparison.
4. **Multiple stores per deployment**, with each voice session scoped to one store's catalog version.
5. **Hosted catalog storage** in place of JSON files on the server.
6. **Real checkout**: payment, inventory and order systems. Checkout is a simulation today.
7. **Browser voice tests on every onboarded catalog**, so each new store gets the same spoken journey check as the demo.
