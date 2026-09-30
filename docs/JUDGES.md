# VoiceCart AI in 3 minutes

## Minute 1: shop by voice

Open **https://voicecart-ai-o76d.onrender.com/** in Chrome or Edge, allow the microphone, press the mic and say:

1. "I need a windproof umbrella under 30 dollars." The filters move and the grid updates.
2. "Wait, which one is the lightest?" Say it while the agent is talking, and it stops mid-sentence.
3. "Compare the first two." A comparison table opens.
4. "What do people complain about with the first one?" The answer comes from the store's reviews only.
5. "Add it to my cart. Actually, make it two." Then "Check out", and "Yes, place it."

Prefer to watch? The [3-minute video](https://youtu.be/I15PKSQqyfQ).

## Minute 2: how it uses AssemblyAI

| What you saw | AssemblyAI feature | Where |
|---|---|---|
| One conversation: hearing, thinking, speaking | Voice Agent API over one WebSocket, browser to AssemblyAI | [voice_agent.js](../frontend/js/voice_agent.js) |
| The API key never reaches the browser | Single-use temporary token per session | `GET /api/token` in [main.py](../backend/main.py) |
| Every spoken action changes the page | Client-side JSON-Schema tool calling, 8 tools | [agent_tools.js](../frontend/js/agent_tools.js) |
| Brand names spelled right | `input.keyterms` built from the catalog | [agent_tools.js](../frontend/js/agent_tools.js) |
| Quick, natural turns | `input.turn_detection`, tuned by measurement from 5.7 s to 3.3 s | [voice_latency.py](../scripts/voice_latency.py), README section 6 |
| Stops when you talk over it | Barge-in: `interrupt_response`, `input.speech.started` | [voice_agent.js](../frontend/js/voice_agent.js), [playback_worklet.js](../frontend/js/playback_worklet.js) |
| Remembers the visit | `greeting` and `conversation.message` on reconnect | [voice_agent.js](../frontend/js/voice_agent.js) |
| Instant "Sure, let me look" | Clips recorded from the Voice Agent API's own voice | [record_fillers.py](../scripts/record_fillers.py) |

Architecture: [ARCHITECTURE.md](ARCHITECTURE.md).

## Minute 3: it works for any store

The [`any-store-onboarding`](https://github.com/b25cs1051-KUSH/Assembly_ai_hackathon/tree/any-store-onboarding) branch turns any store's product catalog into a voice store. The AssemblyAI LLM Gateway proposes the catalog configuration once, validation checks it, and a person approves it. Then the same storefront and eight voice tools run on it.

| Open | What it shows |
|---|---|
| [Onboarding report](https://github.com/b25cs1051-KUSH/Assembly_ai_hackathon/blob/any-store-onboarding/docs/onboarding/umbrella-llm-vs-reviewed.md) | The LLM Gateway onboarded our raw catalog and matched our hand-built configuration on all 16 core fields and every comparison direction. |
| [Review report](https://github.com/b25cs1051-KUSH/Assembly_ai_hackathon/blob/any-store-onboarding/docs/onboarding/umbrella-review.md) | What a merchant reads before approving: every mapping, unit and comparison rule, with flags for anything to double-check. |
| [Second-category transcript](https://github.com/b25cs1051-KUSH/Assembly_ai_hackathon/blob/any-store-onboarding/docs/onboarding/dry-fruit-voice-journey.md) | A different product category completing a spoken order, from search to placed order, through the same eight tools. |
| [INTEGRATION.md](https://github.com/b25cs1051-KUSH/Assembly_ai_hackathon/blob/any-store-onboarding/docs/INTEGRATION.md) | The data contract and the four steps a store follows. |
| [ROADMAP.md](ROADMAP.md) | What comes next: Shopify and WooCommerce import, a merchant review screen, real checkout. |

## Why it matters

Online stores have search boxes, not salespeople. VoiceCart gives every store a salesperson that listens, answers from real product data and does the clicking. It also opens shopping to people who can't easily use a screen.
