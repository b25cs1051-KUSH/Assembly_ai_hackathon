/* =================================================================
   AgentTools — client-side tools the voice agent can call.
   Each handler changes the UI and returns compact JSON for the agent.
   Error messages are read by the model word for word, so keep them specific.
   Docs: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools
   ================================================================= */

const AgentTools = (() => {
    const MAX_RESULTS = 5;
    const HIGHLIGHTED = 3;  // the agent walks through the top 3 results
    // Words people say that are not product properties: "show me the yellow umbrellas" → "yellow"
    const FILLER = new Set(['umbrella', 'umbrellas', 'one', 'ones', 'please', 'show', 'me', 'some', 'any', 'the', 'a', 'an']);

    // Ids of the latest search's matches in display order: "position 1" means the first one on screen now,
    // resolved here rather than left to the model's memory of older searches.
    let latestResults = [];

    /* Shown in the voice dock's tool chip while a tool runs */
    const LABELS = {
        search_products: 'Searching the store',
        show_product: 'Opening product details',
        compare_products: 'Comparing umbrellas',
        update_cart: 'Updating your cart',
        checkout: 'Preparing checkout',
        place_order: 'Placing your order',
    };

    /* Built on demand: the brand and product id enums come from the loaded catalog */
    function definitions() {
        const productIds = App.getProducts().map(p => p.id);
        const productId = {
            type: 'string',
            description: 'The product\'s id field, for a product that is not in the latest search. Prefer position for numbered results. Example: "4".',
        };
        if (productIds.length) productId.enum = productIds;  // an empty enum would make every id invalid
        const position = {
            type: 'integer',
            minimum: 1,
            description: 'Result number in the latest search, 1 for the first. Use it when the user says "the first one" or "number two". Give position or product_id.',
        };
        return [
            {
                type: 'function',
                name: 'search_products',
                description: 'Filter the store\'s umbrellas and show the matches on screen; use it whenever the user describes what they want or changes a requirement.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Keywords that must appear in the product name or description, such as "bubble", "kids" or "golf". Leave out for price, wind, weight or rating requirements.',
                        },
                        brand: { type: 'string', ...(App.getBrands().length && { enum: App.getBrands() }), description: 'Only this brand.' },
                        max_price: { type: 'number', description: 'Highest price in US dollars.' },
                        min_rating: { type: 'number', description: 'Lowest average star rating, from 1 to 5.' },
                        min_wind_mph: {
                            type: 'number',
                            description: 'Lowest wind rating in miles per hour. Windproof usually means 50 or more.',
                        },
                        max_weight_oz: {
                            type: 'number',
                            description: 'Highest weight in ounces. Light or backpack friendly usually means 14 or less.',
                        },
                        automatic_open: { type: 'boolean', description: 'True to show only umbrellas that open with one button.' },
                        sort_by: { type: 'string', enum: App.sortOptions, description: 'Result order. Default is relevance.' },
                    },
                },
            },
            {
                type: 'function',
                name: 'show_product',
                description: 'Open one umbrella\'s detail page and get its specs, pros, cons and review summary; use it when the user asks for more about a product or what people say about it.',
                parameters: {
                    type: 'object',
                    properties: { position, product_id: productId },
                },
            },
            {
                type: 'function',
                name: 'compare_products',
                description: 'Show a side-by-side comparison of 2 or 3 umbrellas and get their differences; use it when the user wants to compare or choose between products.',
                parameters: {
                    type: 'object',
                    properties: {
                        positions: {
                            type: 'array',
                            items: { type: 'integer', minimum: 1 },
                            minItems: 2,
                            maxItems: 3,
                            description: 'Result numbers in the latest search, for example [1, 2] for "the first two". Give positions or product_ids.',
                        },
                        product_ids: {
                            type: 'array',
                            items: productId,
                            minItems: 2,
                            maxItems: 3,
                            description: 'Ids of the 2 or 3 products to compare, for example ["1", "4"].',
                        },
                    },
                },
            },
            {
                type: 'function',
                name: 'update_cart',
                description: 'Add a product to the cart, remove it, or set its quantity; returns the updated cart and total.',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['add', 'remove', 'set_quantity'],
                            description: 'add puts quantity more in the cart, remove takes the product out, set_quantity sets an exact amount.',
                        },
                        position,
                        product_id: productId,
                        quantity: { type: 'integer', description: 'How many. Defaults to 1 for add; required for set_quantity. Example: 2.' },
                    },
                    required: ['action'],
                },
            },
            {
                type: 'function',
                name: 'checkout',
                description: 'Open the checkout summary and get the items and order total; use it when the user wants to check out or pay.',
                parameters: { type: 'object', properties: {} },
            },
            {
                type: 'function',
                name: 'place_order',
                description: 'Place the order shown on the checkout screen; use it only after you read the total and the user clearly said yes.',
                parameters: {
                    type: 'object',
                    properties: {
                        user_confirmed: { type: 'boolean', description: 'True only if the user explicitly agreed to place the order.' },
                    },
                    required: ['user_confirmed'],
                },
            },
        ];
    }

    /* Product and brand names bias speech recognition towards the catalog's spelling */
    function keyterms() {
        return ['VoiceCart', ...App.getBrands()];
    }

    /* ── HELPERS ────────────────────────────────────────────────── */
    function optionalNumber(args, key) {
        if (args[key] === undefined || args[key] === null) return undefined;
        const n = Number(args[key]);
        if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a positive number, got "${args[key]}".`);
        return n;
    }

    function product(id) {
        const p = App.getProducts().find(x => x.id === String(id));
        if (!p) throw new Error(`No product with id "${id}". Use the id field from a search_products result.`);
        return p;
    }

    /* Result number N of the latest search, as numbered on screen */
    function atPosition(n) {
        const pos = Number(n);
        if (!latestResults.length) throw new Error('There are no search results yet. Call search_products first.');
        if (!Number.isInteger(pos) || pos < 1 || pos > latestResults.length) {
            throw new Error(`Position ${n} does not exist; the latest search has ${latestResults.length} result${latestResults.length === 1 ? '' : 's'}.`);
        }
        return product(latestResults[pos - 1]);
    }

    /* The product a call is about: position (preferred for numbered results) or product_id */
    function target(args) {
        if (args.position !== undefined && args.position !== null) return atPosition(args.position);
        if (args.product_id !== undefined && args.product_id !== null) return product(args.product_id);
        throw new Error('Give position (its number in the latest search) or product_id.');
    }

    /* Position in the latest search, or null if it is not in it */
    function positionOf(id) {
        const i = latestResults.indexOf(id);
        return i < 0 ? null : i + 1;
    }

    /* "show me the yellow umbrellas" → "yellow": drop filler words and plural s, so every word left must match */
    function cleanQuery(query) {
        return String(query).toLowerCase().split(/[^a-z0-9]+/)
            .filter(w => w && !FILLER.has(w))
            .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
            .join(' ');
    }

    function details(p) {
        return {
            position: positionOf(p.id),
            id: p.id,
            name: p.name,
            brand: p.brand,
            price: p.price,
            rating: p.rating,
            review_count: p.review_count,
            specs: p.specs,
            pros: p.pros,
            cons: p.cons,
            reviews_summary: p.reviews_summary,
            // Grounds answers to "what do people complain about?" in real review text
            critical_reviews: (p.reviews || []).filter(r => r.rating <= 4).sort((a, b) => a.rating - b.rating)
                .slice(0, 3).map(r => ({ rating: r.rating, text: r.text })),
            top_reviews: (p.reviews || []).filter(r => r.rating === 5).slice(0, 2).map(r => ({ rating: r.rating, text: r.text })),
        };
    }

    function cartResult() {
        const c = App.getCartSummary();
        return {
            items: c.items.map(i => ({ id: i.id, name: i.name, quantity: i.qty, line_total: i.lineTotal })),
            item_count: c.itemCount,
            subtotal: c.subtotal,
            tax: c.tax,
            total: c.total,
        };
    }

    function summary(p, i) {
        return {
            position: i + 1,
            id: p.id,
            name: p.name,
            brand: p.brand,
            price: p.price,
            rating: p.rating,
            wind_mph: p.specs.wind_rating_mph,
            weight_oz: p.specs.weight_oz,
            automatic_open: p.specs.automatic_open,
            // Optional in the data: a missing field must not make the whole search fail
            best_point: (p.pros || [])[0] || null,
            main_drawback: (p.cons || [])[0] || null,
        };
    }

    /* ── HANDLERS ───────────────────────────────────────────────── */
    const handlers = {
        search_products(args) {
            const filters = {};
            const query = args.query ? cleanQuery(args.query) : '';
            if (query) filters.search = query;
            if (args.brand) {
                if (!App.getBrands().includes(args.brand)) {
                    throw new Error(`Unknown brand "${args.brand}". Brands in the store: ${App.getBrands().join(', ')}.`);
                }
                filters.brand = args.brand;
            }
            if (args.sort_by) {
                if (!App.sortOptions.includes(args.sort_by)) {
                    throw new Error(`Unknown sort_by "${args.sort_by}". Use one of: ${App.sortOptions.join(', ')}.`);
                }
                filters.sortBy = args.sort_by;
            }
            const maxPrice = optionalNumber(args, 'max_price');
            const minRating = optionalNumber(args, 'min_rating');
            const minWind = optionalNumber(args, 'min_wind_mph');
            const maxWeight = optionalNumber(args, 'max_weight_oz');
            if (maxPrice !== undefined) filters.maxPrice = maxPrice;
            if (minRating !== undefined) filters.minRating = minRating;
            if (minWind !== undefined) filters.minWind = minWind;
            if (maxWeight !== undefined) filters.maxWeight = maxWeight;
            if (args.automatic_open === true) filters.autoOpen = true;

            App.closeAllPanels();
            UI.highlightCard(null);  // the outline belonged to the previous search
            const matches = App.setFilters(filters);
            latestResults = matches.map(p => p.id);
            UI.markPositions(matches.slice(0, HIGHLIGHTED).map(p => p.id));
            document.getElementById('products-section').scrollIntoView({ behavior: 'smooth' });

            if (!matches.length) {
                return {
                    total_matches: 0,
                    query_used: query,
                    results: [],
                    note: 'No umbrellas match these filters. Tell the user and offer to relax one of them.',
                };
            }
            return {
                total_matches: matches.length,
                query_used: query,
                results: matches.slice(0, MAX_RESULTS).map(summary),
                note: 'Positions refer to this search only; earlier positions no longer apply.',
            };
        },

        show_product(args) {
            const p = target(args);
            App.closeAllPanels();
            App.openDetail(p.id);
            UI.highlightCard(p.id);
            return details(p);
        },

        compare_products(args) {
            const picked = args.positions && args.positions.length
                ? args.positions.map(n => atPosition(n).id)
                : (args.product_ids || []).map(String);
            const ids = [...new Set(picked)];
            if (ids.length < 2 || ids.length > 3) {
                throw new Error(`compare_products needs 2 or 3 different products (positions or product_ids), got ${ids.length}.`);
            }
            const products = ids.map(product);
            App.closeAllPanels();
            App.compareProducts(ids);
            return {
                products: products.map(p => ({
                    position: positionOf(p.id),
                    id: p.id,
                    name: p.name,
                    price: p.price,
                    rating: p.rating,
                    wind_mph: p.specs.wind_rating_mph,
                    weight_oz: p.specs.weight_oz,
                    canopy_inches: p.specs.canopy_size_inches,
                    automatic_open: p.specs.automatic_open,
                    pros: p.pros,
                    cons: p.cons,
                })),
            };
        },

        update_cart(args) {
            const p = target(args);
            const inCart = App.getCartSummary().items.find(i => i.id === p.id);
            const qty = args.quantity === undefined || args.quantity === null ? undefined : Number(args.quantity);
            if (qty !== undefined && (!Number.isInteger(qty) || qty < 0 || qty > 20)) {
                throw new Error(`quantity must be a whole number from 0 to 20, got "${args.quantity}".`);
            }
            if (args.action === 'add') {
                App.addToCart(p.id, qty || 1);
            } else if (args.action === 'remove') {
                if (!inCart) throw new Error(`${p.name} is not in the cart, so there is nothing to remove.`);
                App.removeFromCart(p.id);
            } else if (args.action === 'set_quantity') {
                if (qty === undefined) throw new Error('set_quantity needs a quantity.');
                App.updateQty(p.id, qty);
            } else {
                throw new Error(`Unknown action "${args.action}". Use add, remove or set_quantity.`);
            }
            return cartResult();
        },

        checkout() {
            if (!App.getCartSummary().items.length) {
                throw new Error('The cart is empty. Tell the user and offer to help them find an umbrella.');
            }
            App.openCheckout();
            return {
                ...cartResult(),
                note: 'Read the total to the user and ask them to confirm before calling place_order.',
            };
        },

        place_order(args) {
            if (args.user_confirmed !== true) {
                throw new Error('Not placed. Ask the user to confirm the total first, then call place_order with user_confirmed true.');
            }
            if (!App.getCartSummary().items.length) throw new Error('The cart is empty, so there is no order to place.');
            if (!App.isCheckoutOpen()) throw new Error('Call checkout first so the user can see the order summary.');
            const total = App.getCartSummary().total;
            const orderNumber = App.placeOrder();
            return { order_number: orderNumber, total };
        },
    };

    /* Runs one tool call; throws an Error with a model-readable message on bad input */
    async function run(name, args) {
        const handler = handlers[name];
        if (!handler) throw new Error(`Unknown tool "${name}".`);
        UI.showToolChip(LABELS[name] || name);
        try {
            return await handler(args || {});
        } finally {
            UI.hideToolChip();
        }
    }

    return { definitions, keyterms, run };
})();
