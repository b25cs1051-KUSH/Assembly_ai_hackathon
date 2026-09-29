# umbrella onboarding review

- Proposal: `82c254ff6d22940f`
- Status: **pending_review**
- Source: `data/products.json` (15 records, sha256 `ec9ba6f5e5e0`)
- Products that would be published: 15
- Provider: assemblyai, model: qwen3.5-4b-32k-fast, prompt: catalog-manifest-v2
- Display name: Umbrellas, singular: umbrella, currency: USD

## Validation

- Passed. Nothing was rejected.

## Attempts

Each rejected attempt was sent back to the model with its validation errors.

- Attempt 1: 6 errors
- Attempt 2: passed validation

## Check these

Validation cannot judge these. A reviewer should confirm each one.

- Filter `max_canopy_size` is a max limit on `canopy_size`, where higher is marked better. Confirm shoppers limit it that way.

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
| reviews_summary | `reviews_summary` | 15 of 15 |
| pros | `pros` | 15 of 15 |
| cons | `cons` | 15 of 15 |
| reviews | `reviews` | 15 of 15 |
| color | `color` | 15 of 15 |
| color_family | `color_family` | 15 of 15 |
| model | `model` | 15 of 15 |
| specs | `specs` | 15 of 15 |

## Attributes

| Key | Source | Kind | Unit | Input units | Filters | Compare | Direction | Confidence | Rationale |
|---|---|---|---|---|---|---|---|---|---|
| canopy_size | `specs.canopy_size_inches` (15 of 15) | number | inches | {} | max_canopy_size (max) | true | higher | 0.95 | Shoppers prefer larger coverage for two people or as a tent back; reviews show preference for 'covers two' or 'deep canopy'. |
| wind_resistance | `specs.wind_rating_mph` (15 of 15) | number | mph | {} | min_wind_rating (min) | true | higher | 0.9 | Reviews explicitly praise 100 MPH ratings for surviving wind tunnels and gusts, while 30-50 MPH ratings are noted for struggling. |
| frame_material | `specs.frame_material` (15 of 15) | enum | - | {} | frame_type (equals) | false | none | 0.85 | Frame material dictates durability and weight but has no inherent superiority across all use cases (steel vs aluminum vs wood). |
| automatic_open | `specs.automatic_open` (15 of 15) | boolean | - | {} | auto_open (equals) | false | none | 0.9 | Implicitly preferred for travel and hands-free use, as highlighted in pros text. |
| weight | `specs.weight_oz` (15 of 15) | number | oz | {} | max_weight (max) | true | lower | 0.8 | Reviews repeatedly cite weight as the primary cons ('heavier than compacts', 'heavy for a compact'), indicating lower is generally better for single-person travel. |

## Comparison, search and variants

- Comparison fields: ["price", "rating", "wind_resistance", "weight", "canopy_size"]
- Search fields: ["name", "description", "color", "canopy_size", "frame_material"]
- Variant group source: null, variant value source: null
- Search aliases: [{"phrase": "dome", "parameter": "frame_type", "value": "Aluminum"}, {"phrase": "sturdy wind", "parameter": "min_wind_rating", "value": 100}, {"phrase": "compact", "parameter": "max_weight", "value": 15}]
- Guide questions: ["Which umbrella holds the most coverage for two people?", "What wind rating is required for commute safety?", "I need something lighter than 15 ounces for backpacking."]

## Next step

If every row above is correct, publish with `python -m backend.services.catalog_onboarding --approve 82c254ff6d22940f`.
