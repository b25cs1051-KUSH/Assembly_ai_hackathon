# umbrella onboarding review

- Proposal: `5e5e2f093a2613eb`
- Status: **rejected**
- Source: `data/products.json` (15 records, sha256 `ec9ba6f5e5e0`)
- Products that would be published: 0
- Provider: assemblyai, model: qwen3.5-4b-32k-fast, prompt: catalog-manifest-v1
- Display name: Umbrella, singular: Umbrella, currency: USD

## Validation

- Rejected: schema_version: Input should be 1
- Rejected: search_aliases.0: Input should be a valid dictionary or instance of SearchAlias
- Rejected: search_aliases.1: Input should be a valid dictionary or instance of SearchAlias

## Field mappings

| Field | Source path | Records with a value |
|---|---|---|
| id | `id` | 15 of 15 |
| name | `name` | 15 of 15 |
| description | `description` | 15 of 15 |
| price | `price` | 15 of 15 |
| image_url | `image_url` | 15 of 15 |
| brand | `brand` | 15 of 15 |
| rating | `rating` | 15 of 15 |
| review_count | `review_count` | 15 of 15 |
| reviews | `reviews` | 15 of 15 |
| reviews_summary | `reviews_summary` | 15 of 15 |
| pros | `pros` | 15 of 15 |
| cons | `cons` | 15 of 15 |
| color | `color` | 15 of 15 |
| color_family | `color_family` | 15 of 15 |
| model | `model` | 15 of 15 |
| specs | `specs` | 15 of 15 |
| price_unit | `USD` | 0 of 15 |
| weight_unit | `oz` | 0 of 15 |
| size_unit | `in` | 0 of 15 |
| rating_unit | `1-5` | 0 of 15 |
| color_unit | `color` | 15 of 15 |
| weight_oz | `specs.weight_oz` | 15 of 15 |
| canopy_size_inches | `specs.canopy_size_inches` | 15 of 15 |
| wind_rating_mph | `specs.wind_rating_mph` | 15 of 15 |

## Attributes

| Key | Source | Kind | Unit | Input units | Filters | Compare | Direction | Confidence | Rationale |
|---|---|---|---|---|---|---|---|---|---|
| price | `price` (15 of 15) | number | USD | {} | - | true | lower | 1 | Lower price is generally preferable for better value or to save money. |
| rating | `rating` (15 of 15) | number | 1-5 | {} | - | true | higher | 1 | Higher ratings indicate better customer satisfaction and product quality. |
| review_count | `review_count` (15 of 15) | number | count | {} | - | true | higher | 1 | More reviews provide a larger sample size, increasing confidence in the rating. |
| weight | `specs.weight_oz` (15 of 15) | number | oz | {} | - | true | lower | 1 | Lighter weight is generally preferred for portability, especially for travel umbrellas. |
| size | `specs.canopy_size_inches` (15 of 15) | number | in | {} | - | true | higher | 1 | Larger canopy sizes provide better coverage for rain protection. |
| wind_rating | `specs.wind_rating_mph` (15 of 15) | number | mph | {} | - | true | higher | 1 | Higher wind ratings indicate the umbrella can withstand stronger gusts without inverting. |
| color | `color` (15 of 15) | enum | color | {} | - | false | none | 0 | Color preference is subjective and context-dependent. |
| frame_material | `specs.frame_material` (15 of 15) | text | material | {} | - | false | none | 0 | Material preference is subjective and depends on specific needs like weight vs durability. |

## Comparison, search and variants

- Comparison fields: ["price", "rating", "weight", "size", "wind_rating"]
- Search fields: ["name", "description", "brand", "color", "specs.frame_material"]
- Variant group source: id, variant value source: id
- Search aliases: ["rain", "umbrella"]
- Guide questions: ["What size canopy do you need?", "Are you looking for a lightweight travel umbrella or a more durable building umbrella?", "How much wind do you expect to encounter?"]

## Next step

This proposal cannot be published. Fix the source data or write a manifest by hand (`--manifest-template`), then run onboarding again.
