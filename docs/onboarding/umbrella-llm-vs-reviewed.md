# Umbrella catalog: LLM proposal vs. reviewed manifest

This compares a real onboarding run on `data/products.json` (15 umbrellas) with the manifest a person reviewed and published, `data/catalogs/umbrella/78d63d120639292c/manifest.json`. The live umbrella catalog was not changed.

## The run

- Command: `python -m backend.services.catalog_onboarding data/products.json --category umbrella`
- Provider: AssemblyAI LLM Gateway, model `qwen3.5-4b-32k-fast`, prompt `catalog-manifest-v1`. This is the only gateway model our account can call. Every other listed model we tried (4 Claude, 3 GPT and 2 Gemini models) returned "Your account does not have access to this LLM Gateway model", so no larger model was tested.
- Result: proposal `5e5e2f093a2613eb`, status **rejected**, 0 products publishable. The proposal is in [data/proposals/5e5e2f093a2613eb/](../../data/proposals/5e5e2f093a2613eb/) and the generated review report is [umbrella-review.md](umbrella-review.md).
- The run took about 6 seconds. A second run, kept only in a scratch folder, was also rejected, with 12 errors (invalid `input_units` on all 9 attributes, `search_aliases` not a list, an unknown `presentation` value, `schema_version` again). A third run returned HTTP 429 from the gateway.

The approval gate worked as designed: nothing from this proposal can be published.

## What validation rejected

The report lists 3 errors. Pydantic runs the manifest-wide checks only after every field has the right type, so the report shows one layer at a time. Fixing each error in a scratch copy and validating again found 5 distinct failures in total:

1. `schema_version` was the string `"1"`, not the number `1`.
2. `search_aliases` were bare strings (`"rain"`, `"umbrella"`) instead of `{phrase, parameter, value}` objects.
3. `field_map` had 8 keys that are not store fields (`price_unit`, `weight_unit`, `size_unit`, `rating_unit`, `color_unit`, `weight_oz`, `canopy_size_inches`, `wind_rating_mph`). Four of them point at paths that do not exist in the data (`USD`, `oz`, `in`, `1-5`).
4. 4 attributes (`price`, `rating`, `review_count`, `color`) duplicate built-in product fields.
5. `search_fields` used the source path `specs.frame_material` instead of the attribute key `frame_material`.

After those 5 fixes the manifest validates. Fixing them by hand would still leave the problems below, which validation cannot see.

## Field by field

| Part | Reviewed | LLM proposal | Matched |
|---|---|---|---|
| Core field mappings | 16 | same 16, plus 8 invalid extras | 16 of 16 |
| Attribute sources found | 5 | 4 (missed `specs.automatic_open`) | 4 of 5 |
| Attribute key names | `weight_oz`, `canopy_size_inches`, `wind_rating_mph`, `frame_material` | `weight`, `size`, `wind_rating`, `frame_material` | 1 of 4 identical (the renames are harmless) |
| Attribute kind | number, number, number, text | same | 4 of 4 |
| Unit | oz, in, mph, none | oz, in, mph, "material" | 3 of 4 |
| Comparison direction | weight lower, canopy higher, wind higher, material none | same | 4 of 4 |
| Confidence | 0.82, 0.85, 0.95, 0 | 1, 1, 1, 0 | differs: the LLM gave full confidence to every numeric direction |
| Included in comparison | all 4 | frame material excluded | 3 of 4 |
| Search filters | `max_weight_oz`, `min_wind_mph`, `automatic_open` | none | 0 of 3 |
| Comparison fields | 11 | 5, all of them among the reviewed 11 | 5 of 11 (missing brand, color, frame material, auto-open, pros, cons) |
| Search fields | 5 | 5 | 4 of 5 (frame material by path, rejected) |
| Variant grouping | group by `model`, variant `color` | `id` and `id` | 0 of 2 |
| Search aliases | 6 (e.g. "windproof" means wind rating at least 50 mph) | 2 bare strings | 0 of 6 |
| Guide questions | 3 example things to say | 3 questions to ask the shopper | 0 of 3 |
| Currency | USD | USD | yes |
| Display name, singular | Umbrellas, umbrella | Umbrella, Umbrella | wording only |
| Presentation | `umbrella_demo` | `generic` | differs as expected: the prompt asks for `generic`, and `umbrella_demo` is reserved for the original storefront |

## Why they differ

- **The prompt leaves some shapes undefined.** It names `search_aliases`, `guide_questions` and the variant paths as required keys but never describes them. All three undescribed parts (aliases, guide questions, variants) got 0 matches. It says `schema_version (1)` in prose, and the model returned a string.
- **The model mixed up store fields and attributes.** It repeated price, rating, review count and color as attributes and added unit notes to `field_map`. The prompt says which fields `field_map` accepts, but a 4B model did not follow it.
- **Direction reasoning was correct.** On the four attributes it found, the model picked the same kind, the same direction and the same numeric units as the reviewer. Its confidence was higher than the reviewer's.
- **Things validation cannot catch.** Grouping variants by `id` is valid but would treat every color as a separate product. A missing auto-open filter and missing comparison fields are also valid. Only a person reading the report catches these. That is why publishing requires `--approve`.

## What this means

Structured source data made the core mapping easy: the LLM got all 16 core fields right. Category judgement (filters, aliases, variants) is where the small model fell short, and where the review step does its job. Planned next: describe every manifest shape in the prompt, list every validation failure in one pass, and run the comparison again with a larger gateway model once our account has access.
