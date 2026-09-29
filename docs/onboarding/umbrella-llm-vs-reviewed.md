# Umbrella catalog: LLM proposal vs. reviewed manifest

This compares real onboarding runs on `data/products.json` (15 umbrellas) with the manifest a person reviewed and published, `data/catalogs/umbrella/78d63d120639292c/manifest.json`. The live umbrella catalog was not changed by any run.

All runs used the AssemblyAI LLM Gateway with `qwen3.5-4b-32k-fast`, the only gateway model our account can call. Every other listed model we tried (4 Claude, 3 GPT and 2 Gemini models) returned "Your account does not have access to this LLM Gateway model". This model also rejects the gateway's `response_format` option ("model qwen3.5-4b-32k-fast does not support response_format"), so schema-enforced output could not be used.

## Summary

| | Prompt v1 | Prompt v2 with retries |
|---|---|---|
| Committed proposal | [5e5e2f093a2613eb](../../data/proposals/5e5e2f093a2613eb/), [report](umbrella-review-v1.md) | [82c254ff6d22940f](../../data/proposals/82c254ff6d22940f/), [report](umbrella-review.md) |
| Result | **rejected**, 0 products | **passed validation**, 15 products, on attempt 2 |
| Runs that finished | 2 of 3, both rejected | 3 of 6, all 3 passed validation (on attempts 2, 3 and 2). The other 3 got HTTP 429 from the gateway. |
| Core field mappings | 16 of 16, plus 8 invalid extras | 16 of 16, no extras |
| Attribute sources found | 4 of 5 | 5 of 5 |
| Comparison direction | 4 of 4 found | 5 of 5 |
| Search filters (by meaning) | 0 of 3 | 3 of 3, plus 2 extra |

The approval gate worked in both cases: v1 could not be published, and v2 could be. To check that, we approved a copy of v2 into a scratch folder and it published 15 products. We did **not** approve it into the live catalog, because the reviewed manifest stays live and a reviewer would still fix the points below first.

## What changed between v1 and v2

- **The prompt describes every shape.** v1 named `search_aliases`, `guide_questions` and the variant paths without describing them, and those three parts got 0 matches. v2 spells out each shape, says `schema_version` is a number, and says attribute keys must not repeat store fields. Its examples use a different category (backpacks), so they don't hint at the umbrella answers.
- **Rejected replies are sent back.** The model gets its validation errors and up to two more tries. In the committed v2 run, attempt 1 had 6 errors: a misspelled key (`rationle`) on all 5 attributes and one alias pointing at a missing filter. Attempt 2 fixed all of them.
- **Validation reports everything at once.** v1's report showed 3 of its 5 failures, because Pydantic runs the manifest-wide checks only after field types pass. Those checks now run separately, so every problem is listed in one pass.

## v2 field by field

| Part | Reviewed | v2 proposal | Matched |
|---|---|---|---|
| Core field mappings | 16 | same 16 | 16 of 16 |
| Attribute sources | 5 (`specs.*`) | same 5 | 5 of 5 |
| Attribute key names | `frame_material`, `canopy_size_inches`, `wind_rating_mph`, `weight_oz`, `automatic_open` | `frame_material`, `canopy_size`, `wind_resistance`, `weight`, `automatic_open` | 2 of 5 identical (the renames are harmless) |
| Kind | text, number, number, number, boolean | enum, number, number, number, boolean | 4 of 5 |
| Unit | none, in, mph, oz, none | none, inches, mph, oz, none | 5 of 5 by meaning, 4 of 5 spelled the same |
| Comparison direction | none, higher, higher, lower, none | same | 5 of 5 |
| Included in comparison | all 5 | frame material and auto-open excluded | 3 of 5 |
| Search filters | wind min, weight max, auto-open equals | the same three, plus frame type (equals) and canopy size (max) | 3 of 3 |
| Comparison fields | 11 | price, rating, wind, weight, canopy | 5 of 11 (missing brand, color, frame material, auto-open, pros, cons) |
| Search fields | name, description, brand, color, frame material | name, description, color, canopy size, frame material | 4 of 5 (missing brand) |
| Variant grouping | `model` and `color` | none | 0 of 2. No effect on this catalog, because no two records share a `model` value. |
| Search aliases | 6 phrases for 3 filters (wind at least 50 mph, weight at most 14 oz, auto-open) | "sturdy wind" = wind at least 100 mph, "compact" = weight at most 15 oz, "dome" = frame "Aluminum" | 2 of 3 filters covered, with different phrases and thresholds. "dome" meaning aluminum is wrong. |
| Guide questions | 3 things a shopper says | 3 things a shopper says | right form |
| Display name, singular | Umbrellas, umbrella | Umbrellas, umbrella | exact |
| Presentation | `umbrella_demo` | `generic` | differs as expected: `umbrella_demo` is reserved for the original storefront |

## What a reviewer would still fix in v2

1. **A `max` filter on canopy size**, where larger is marked better. The report's "Check these" section flags this.
2. **The alias "dome" = frame "Aluminum".** It is valid, and one record has exactly that value, but it has the wrong meaning. No automatic check can see this.
3. **An invented rationale detail.** The canopy rationale says "or as a tent back". "Tent" appears nowhere in the data. Its other quotes ("covers two", "deep canopy", "wind tunnel", "heavy for a compact") do appear in the product reviews. The comparison tool returns rationales to the voice agent, so they must be checked.
4. **Fewer comparison fields** than the reviewed manifest (5 of 11), and brand missing from search.

## v1 details

v1 failed 5 checks: `schema_version` was the string `"1"`; `search_aliases` were bare strings; `field_map` had 8 keys that are not store fields, 4 of them pointing at paths that don't exist (`USD`, `oz`, `in`, `1-5`); 4 attributes duplicated built-in fields (`price`, `rating`, `review_count`, `color`); and `search_fields` used a source path instead of an attribute key. It also found no filters, missed `specs.automatic_open`, gave every numeric direction confidence 1, and grouped variants by `id`. A second v1 run, kept only in scratch, was rejected with 12 errors, and a third returned HTTP 429.

## What this means

With structured source data, even a 4B model got every core field and every comparison direction right once the prompt described the contract and the model could see its validation errors. Category judgement is still where it slips: one wrong alias, one odd filter and one invented rationale detail. The report points a reviewer at some of these, and only a person catches the rest. That is why publishing requires `--approve`. Planned next: run the same comparison with a larger gateway model once our account has access.
