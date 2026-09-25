# VoiceCart AI — Implementation Plan

**Goal:** a demo umbrella store where a voice agent built on AssemblyAI's **Voice Agent API** runs the whole
shopping flow: it greets you, finds umbrellas, walks through the options with pros and cons, compares
them, adds to cart and checks out. It always stops talking the moment the user speaks.

**Deadline:** Wed 30 Sep 2026, 20:30 IST. **Feature freeze:** Tue 29 Sep, evening IST.
30 Sep is for deploy checks, video, slides and submission only.

---

## 1. How it works

```
Browser (vanilla JS)                           FastAPI (our server)            AssemblyAI (their cloud)
────────────────────                           ────────────────────            ────────────────────────
click "Start shopping"
  GET /api/token  ───────────────────────────▶ mints single-use token ───────▶ GET /v1/token
  WebSocket wss://agents.assemblyai.com/v1/ws?token=…  ◀──── direct, our server not in the loop ────▶
     session.update: system_prompt, greeting, tools, keyterms, turn_detection
     mic → input.audio (PCM16, 24 kHz)             AssemblyAI does: speech-to-text, turn detection,
     reply.audio → speakers                        the LLM (their managed model), text-to-speech
     tool.call  → run tool in the browser → update the UI → tool.result
  GET /api/products  ────────────────────────▶ JSON catalog
```

- **The AssemblyAI API key stays on our server.** The browser only ever gets a single-use token.
- **Tools run in the browser.** Every tool call changes something on screen, which is the core of the demo.
- The server does exactly two things: mint tokens and serve the catalog and the static site.

## 2. Actions the agent can take

The *actions* are fixed. The *phrasing* is free: the LLM maps whatever the user says onto one of these
tools. There is no keyword matching.

| User says (examples) | Tool | What changes on screen |
|---|---|---|
| "windproof umbrella under 30 dollars", "something light for my backpack" | `search_products` | Filter bar controls move, grid re-filters, top results get numbered badges |
| (agent walks through the results on its own) | uses `search_products` results | The card being discussed is highlighted |
| "tell me more about the second one", "what do people complain about?" | `show_product` | Detail drawer opens with specs and reviews |
| "compare the first two", "compare TUMELLA and Repel" | `compare_products` | Comparison modal with 2–3 products |
| "add it", "make it two", "remove the Repel" | `update_cart` | Cart badge animates, cart drawer shows the change |
| "check out" | `checkout` | Order summary opens; agent reads back the total and asks to confirm |
| "yes, place it" | `place_order` | Confirmation screen, cart cleared |

Tool rules: every categorical parameter uses an `enum`; each description is one sentence saying what it
does and when to use it; results are compact JSON strings; error messages are specific, because the
model reads them word for word.

## 3. The conversation flow

1. **Arrive.** Browsers block both microphone and sound until the user interacts with the page, so the
   agent **cannot** speak the moment the page loads. On first load, show a centred
   **"Start shopping with voice"** button. One click starts the session and plays the greeting:
   *"Hi, I'm your VoiceCart assistant. What kind of umbrella are you looking for?"*
2. **Ask.** The user describes what they need, and the agent calls `search_products` with structured filters.
3. **Walk through.** The agent covers the **top 3** results, one sentence each: the best point and the
   main drawback. The card it's talking about is highlighted. It then asks which one interests them.
   It doesn't read all 15. That's too long to listen to, and people interrupt.
4. **Refine / compare / inspect.** Any order, as many times as needed.
5. **Cart → checkout → confirm.** The agent never places an order without an explicit "yes".
6. **Barge-in at any point.** Playback stops immediately. Unfinished tool results from the
   interrupted reply are thrown away.

## 4. Build phases

Each phase ends with something that works in the browser. Don't start the next phase until the
current one passes its **done when** check.

### Phase 0 — Foundation (Thu 25 Sep)
- [ ] Commit the voice pipeline already built on `feat/voice-agent` (`/api/token`, mic worklet, playback,
      barge-in, voice dock) and merge to `main`.
- [ ] Ruff clean-up of old backend code (style only, separate commit).
- [ ] **Deploy now**, not on the last day (Render or Railway; HTTPS is required for the mic). Set
      `ASSEMBLYAI_API_KEY` in the host's environment settings.

**Done when:** you can talk to the bare agent on the public HTTPS URL.

### Phase 1 — Tool framework + search (Fri 26 Sep)
- [ ] `frontend/js/agent_tools.js`: tool definitions (JSON Schema) and one handler per tool.
- [ ] Tool-result queue in `voice_agent.js`: send `tool.result` only when `reply.done` is the latest
      event; if the reply was interrupted, throw pending results away (AssemblyAI's documented rule).
- [ ] `search_products` sets the app's filters and calls `applyFilters()`, so the grid, the filter bar and
      the agent see exactly the same results. Filters: `query`, `max_price`, `min_rating`, `min_wind_mph`,
      `max_weight_oz`, `automatic_open`, `sort_by` (enum). Returns the top 5 (id, name, price, rating, key specs).
- [ ] Keyterms: every brand name from the catalog.
- [ ] System prompt v1: grounded, short spoken replies, friendly, apologises and corrects itself when wrong.
- [ ] "Start shopping with voice" welcome button.

**Done when:** "windproof under 30 dollars" filters the grid, and the agent names only products that are
actually on screen.

### Phase 2 — Walkthrough, detail, compare (Sat 27 Sep)
- [ ] **Data:** add `pros` and `cons` (two short phrases each) to every product in `products.json`, taken
      from its reviews, so the walkthrough is grounded in data rather than invented.
- [ ] Walkthrough highlight: `search_products` numbers the results 1–3; the UI highlights a card when the
      agent's live transcript mentions that product's brand or number. This costs no extra tool calls.
      If matching turns out unreliable, fall back to a `highlight_product` tool.
- [ ] `show_product` (opens detail drawer; returns specs, pros, cons, review summary).
- [ ] `compare_products` (2–3 ids; opens compare modal; returns the differences).
- [ ] Agent can refer to "the second one" / "the cheaper one": results carry position numbers.

**Done when:** search → spoken pros/cons of 3 options with highlights → "compare the first two" works.

### Phase 3 — Cart + checkout (Sun 28 Sep)
- [ ] `update_cart` (`action`: `add` / `remove` / `set_quantity`), with a cart badge animation.
- [ ] `checkout` shows the summary; the agent reads back the total and asks for confirmation.
- [ ] `place_order` only after an explicit "yes"; shows the confirmation screen.
- [ ] "Agent is doing X" chip in the voice dock whenever a tool runs (makes tool calling visible in the video).

**Done when:** the full demo script (section 5) runs end to end by voice without a single click after
"Start".

### Phase 4 — Hardening + polish (Mon 29 Sep, freeze in the evening)
- [ ] Tune turn detection by ear. Starting point: `min_silence` 1400 ms, `max_silence` 4000 ms.
- [ ] Iterate the prompt by listening, not by adding words.
- [ ] Run the test scenarios in section 6 on the deployed URL, with headphones **and** with laptop speakers.
- [ ] Edge cases: mic denied, token failure, socket drop, no search results, unknown product.
- [ ] Stretch, only if everything above is solid: run the agent on Claude via AssemblyAI's LLM Gateway.
      That setting exists only on *stored agents* (`POST /v1/agents`), and the docs don't say whether a
      stored agent can be combined with our browser tools, so spike it first (≤1 hour).

### Phase 5 — Submission (Wed 30 Sep)
- [ ] Rewrite `README.md`, `docs/ARCHITECTURE.md` and `docs/slides_content.md` to describe what we
      actually built. The current slides describe the old design and claim things that don't exist
      (Redis, Kubernetes, "60% faster", "sub-300ms").
- [ ] Record the 2–3 min video from the demo script; name each AssemblyAI feature as it happens.
- [ ] Cover image, short and long description, tech tags, app URL, and a public repo check (no secrets,
      MIT license file).

## 5. Demo script (what the video shows)

1. Click **Start** → greeting.
2. "I need a windproof umbrella under 30 dollars that fits in a backpack." → grid filters, walkthrough
   of 3 with highlights.
3. **Interrupt mid-walkthrough:** "Wait, which one is the lightest?" → agent stops instantly and answers.
4. "Compare that one with the TUMELLA." → comparison modal.
5. "What do people complain about with the TUMELLA?" → detail drawer, review-based answer.
6. "Add the TUMELLA. Actually, make it two." → cart updates.
7. "Check out." → total read back → "Yes." → confirmation.

## 6. Test scenarios (run before freeze)

| # | Scenario | Pass if |
|---|---|---|
| 1 | Multi-constraint search | Only matching products are shown and named |
| 2 | Search with no results | Agent says so and suggests relaxing a filter |
| 3 | Barge-in during a long reply | Audio stops within ~0.3 s; agent answers the new question |
| 4 | Ask about a spec not in the data | Agent says it doesn't know; doesn't invent |
| 5 | "The second one" after a search | Correct product |
| 6 | Mispronounced brand name | Keyterms get it right |
| 7 | "Check out" with empty cart | Agent says the cart is empty |
| 8 | "Check out", then "no" | Order not placed |
| 9 | Mic permission denied | Clear message, page still usable by clicking |
| 10 | Laptop speakers, no headphones | Agent doesn't interrupt itself |

## 7. Risks

| Risk | Mitigation |
|---|---|
| AssemblyAI's managed model misuses tools | Few tools, strict enums, specific error messages; Claude via Gateway as a fallback |
| Echo: agent hears itself on laptop speakers | Browser echo cancellation is on; record the video with a headset |
| Pause while a tool result waits for `reply.done` | Keep tools fast (data is already in the browser) |
| Deploy surprises (HTTPS, mic, WebSocket) | Deploy in Phase 0 and test the public URL every phase |
| Amazon-sourced images and real brands with sample reviews | Images are stored locally; footer and README say "demo store, sample reviews" |

## 8. Suggested split

- **Kush:** voice pipeline, tool framework, prompt and turn tuning, deploy.
- **Jatin:** tool → UI handlers (highlight, badges, cart animation, tool chip), `pros`/`cons` data,
  README, slides, video.
