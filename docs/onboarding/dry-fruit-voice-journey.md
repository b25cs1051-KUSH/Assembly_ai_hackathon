# Spoken journey on a second catalog

One live AssemblyAI Voice Agent session ran on the 3-product dry-fruit test catalog (`tests/fixtures/catalogs/dry_fruits/`). It used the same system prompt, tool definitions, keyterms and turn detection the page sends.

How it ran:
- The shopper's 8 lines were synthesized with Windows speech synthesis as 24 kHz PCM16 audio and streamed at real-time speed by `run_session` in `scripts/voice_latency.py`.
- Tool calls were answered by the page's own `frontend/js/agent_tools.js`, run in Node by `scripts/agent_tools_host.js` with `CATALOG_ROOT=tests/fixtures/catalogs ACTIVE_CATALOG=dry_fruits`.
- This checks speech recognition, the agent's tool choice and its spoken answers. It does not check the browser UI. For the UI, the storefront served from the same fixture renders its own filters (pack weight, origin, protein, roasted) and cards.

## Result

All 8 turns called the expected tool. The order was placed only after the shopper said yes.

| # | Shopper (as transcribed) | Tool call | Agent said |
|---|---|---|---|
| 1 | "Show me almonds under $20." | `search_products {max_price: 20, query: "almonds"}` | Two options, introduced by position and brand with rounded prices ("about nine dollars", "about fifteen dollars"), then asked which one. |
| 2 | "Tell me more about the first one." | `show_product {position: 1}` | 250 gram pack, raw, from California, about 21 g protein per 100 g. |
| 3 | "Compare the first 2." | `compare_products {positions: [1, 2]}` | Raw for about nine dollars, roasted for about fifteen. |
| 4 | "Remove the second one from the comparison." | `update_compare {action: "remove", columns: [2]}` | Removed the roasted almonds; comparison closed with one product left. |
| 5 | "Add the first one to my cart." / "Make it 2." | `update_cart {action: "add", position: 1, quantity: 2}` | Added two packs. |
| 6 | "What is in my cart?" | `show_cart {}` | Two packs of the raw almonds. |
| 7 | "Checkout." | `checkout {position: 1, product_id: "DF-ALM-250", quantity: 2}` | Read the order and total and asked to confirm. |
| 8 | "Yes." / "Place the order." | `place_order {user_confirmed: true}` | Order placed, with the order number. |

## What didn't match the prompt

- In turns 5 to 7 the agent read the total as "nineteen dollars and forty two cents" instead of rounding it.
- In turn 3 it compared only prices. That is a limit of this test setup: the Node tool host returns a price-only comparison matrix, while the browser gets the full matrix (pack weight, origin, protein, roasted) from `POST /api/products/compare`.

The rounding miss is a prompt-following slip, not a tool error. This was a single run.
