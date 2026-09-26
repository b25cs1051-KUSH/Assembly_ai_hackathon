/* =================================================================
   AgentTools — client-side tools the voice agent can call.
   Each handler changes the UI and returns compact JSON for the agent.
   Error messages are read by the model word for word, so keep them specific.
   Docs: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools
   ================================================================= */

const AgentTools = (() => {
    const MAX_RESULTS = 5;
    const HIGHLIGHTED = 3;  // the agent walks through the top 3 results
    // Words people say that are not product properties: "show me the yellow umbrellas" → "yellow".
    // Prices, wind and weight have their own filters, so their wording ("under 30 dollars") is dropped too.
    const FILLER = new Set([
        'umbrella', 'umbrellas', 'one', 'ones', 'please', 'show', 'me', 'some', 'any', 'the', 'a', 'an',
        'i', 'my', 'need', 'want', 'find', 'get', 'looking', 'look', 'for', 'something', 'that', 'with', 'and', 'in', 'of',
        'it', 'is', 'to', 'can', 'you', 'have', 'like', 'good', 'nice', 'really', 'very',
        'under', 'below', 'less', 'than', 'over', 'above', 'around', 'about', 'dollar', 'dollars', 'bucks', 'usd',
        'cheap', 'cheaper', 'cheapest', 'color', 'colour', 'colored', 'coloured',
    ]);

    // Spoken spec words become structured filters (unless the agent already set that filter) and leave the text
    // query: "windproof" must find a 55 mph golf umbrella whose description never says "windproof".
    const SPEC_WORDS = [
        { re: /\bwind[\s-]*(?:proof|resistant|resistance)\b/g, key: 'min_wind_mph', value: 50 },
        { re: /\b(?:light|lightweight)\b/g, key: 'max_weight_oz', value: 14 },
        { re: /\bauto(?:matic)?(?:[\s-]+open(?:ing)?)?\b/g, key: 'automatic_open', value: true },
    ];

    // Ids of the latest search's matches in display order: "position 1" means the first one on screen now,
    // resolved here rather than left to the model's memory of older searches.
    let latestResults = [];

    /* Shown in the voice dock's tool chip while a tool runs */
    const LABELS = {
        search_products: 'Searching the store',
        show_product: 'Opening product details',
        compare_products: 'Comparing umbrellas',
        update_compare: 'Updating the comparison',
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
        const color = {
            type: 'string',
            description: 'Switch to the same umbrella in this color, for example "red" or "navy blue", when the user asks for another color. Leave out to keep the color it has.',
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
                        color: {
                            type: 'string',
                            description: 'Only umbrellas in this color, for example "blue", "pink", "clear" or "floral". Matches both basic colors and color names.',
                        },
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
                description: 'Open one umbrella\'s detail page and get its specs, pros, cons, review summary and other colors; use it when the user asks for more about a product, what people say about it, or to see it in another color.',
                parameters: {
                    type: 'object',
                    properties: { position, product_id: productId, color },
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
                name: 'update_compare',
                description: 'Remove umbrellas from the open comparison, add one to it, or clear it; use it when the user wants to take something out of or add something to the comparison.',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['remove', 'add', 'clear'],
                            description: 'remove takes products out, add puts one more in (at most 3), clear empties the comparison and closes it.',
                        },
                        columns: {
                            type: 'array',
                            items: { type: 'integer', minimum: 1 },
                            description: 'For remove: column numbers in the comparison table, 1 for the leftmost, for example [2] for "remove the second one".',
                        },
                        positions: {
                            type: 'array',
                            items: { type: 'integer', minimum: 1 },
                            description: 'For add: result numbers in the latest search, for example [4].',
                        },
                        product_ids: {
                            type: 'array',
                            items: productId,
                            description: 'Product ids to remove or add, for example ["2"].',
                        },
                    },
                    required: ['action'],
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
                        color,
                        quantity: { type: 'integer', description: 'How many. Defaults to 1 for add; required for set_quantity. Example: 2.' },
                    },
                    required: ['action'],
                },
            },
            {
                type: 'function',
                name: 'checkout',
                description: 'Open the checkout summary and get the items and order total; use it when the user wants to check out or pay. If they name an umbrella to buy, pass it and it is added to the cart first.',
                parameters: {
                    type: 'object',
                    properties: {
                        position,
                        product_id: productId,
                        color,
                        quantity: { type: 'integer', minimum: 1, description: 'How many of that umbrella, if it is not in the cart yet. Defaults to 1.' },
                    },
                },
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

    /* Ids that positions count through: the latest search, or the grid on screen before any search */
    function numbered() {
        return latestResults.length ? latestResults : App.getVisible().map(p => p.id);
    }

    /* Result number N of the latest search, as numbered on screen */
    function atPosition(n) {
        const pos = Number(n);
        const ids = numbered();
        if (!ids.length) throw new Error('No umbrellas are on screen. Call search_products first.');
        if (!Number.isInteger(pos) || pos < 1 || pos > ids.length) {
            const count = ids.length === 1 ? 'only 1 umbrella' : `only ${ids.length} umbrellas`;
            throw new Error(`Out of range: the latest search has ${ids.length} result${ids.length === 1 ? '' : 's'}. `
                + `Tell the user there are ${count} in the results, so number ${n} is out of range, `
                + `and ask if they want number ${ids.length}, the last one, instead.`);
        }
        return product(ids[pos - 1]);
    }

    /* The product a call is about: position (preferred for numbered results) or product_id, then color */
    function target(args) {
        let p;
        if (args.position !== undefined && args.position !== null) p = atPosition(args.position);
        else if (args.product_id !== undefined && args.product_id !== null) p = product(args.product_id);
        else throw new Error('Give position (its number in the latest search) or product_id.');
        return args.color ? inColor(p, args.color) : p;
    }

    /* Every color of the same umbrella, in catalog order */
    function colorsOf(p) {
        return App.getProducts().filter(x => x.model === p.model);
    }

    /* The same umbrella in the spoken color: an exact color name wins over a color family match */
    function inColor(p, spoken) {
        const siblings = colorsOf(p);
        const want = String(spoken).toLowerCase().trim();
        const match = siblings.find(x => x.color.toLowerCase() === want)
            || siblings.find(x => App.colorMatches(x, want));
        if (match) return match;
        throw new Error(siblings.length > 1
            ? `The ${p.model} does not come in ${spoken}. It comes in ${siblings.map(x => x.color).join(', ')}. Tell the user and offer one of these.`
            : `The ${p.model} only comes in ${p.color}. Tell the user and offer to search for a ${spoken} umbrella instead.`);
    }

    /* Position in the latest search, or null if it is not in it */
    function positionOf(id) {
        const i = numbered().indexOf(id);
        return i < 0 ? null : i + 1;
    }

    /* The open comparison, by column, for the agent */
    function compareResult() {
        const ids = App.getCompareIds();
        return {
            products: ids.map((id, i) => {
                const p = product(id);
                return {
                    column: i + 1,
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
                };
            }),
        };
    }

    /* Words that name a color in the catalog ("black", "navy", "rainbow"). In a query they are matched against
       the color, not the text: "black" must not find a pink umbrella whose description mentions a black handle,
       and "red" must not match "covered". */
    function colorWords() {
        const words = new Set(['gray', 'grey']);
        App.getProducts().forEach(p => `${p.color || ''} ${p.color_family || ''}`.toLowerCase()
            .split(/[^a-z]+/).forEach(w => { if (w.length > 2) words.add(w); }));
        return words;
    }

    /* "show me the yellow umbrellas" → "yellow": drop filler words and word endings, so every word left must match.
       Words match as substrings, so the stem "kid" finds "kids" and "travel" finds "traveling". */
    function cleanQuery(query) {
        return String(query).toLowerCase().split(/[^a-z0-9]+/)
            .filter(w => w && !FILLER.has(w) && !/^\d+$/.test(w))  // bare numbers belong to price, wind or weight
            .map(stem)
            .join(' ');
    }

    function stem(w) {
        if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3).replace(/(.)\1$/, '$1');  // travelling → travel
        if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
        return w;
    }

    /* Same text app.js applyFilters searches */
    function searchText(p) {
        return `${p.name} ${p.brand} ${p.color} ${p.color_family} ${p.description} ${p.specs.frame_material}`.toLowerCase();
    }

    function details(p) {
        return {
            position: positionOf(p.id),
            id: p.id,
            name: p.name,
            brand: p.brand,
            color: p.color,
            other_colors: colorsOf(p).filter(x => x.id !== p.id).map(x => ({ color: x.color, id: x.id })),
            price: p.price,
            rating: p.rating,
            review_count: p.review_count,
            specs: p.specs,
            pros: p.pros,
            cons: p.cons,
            reviews_summary: p.reviews_summary,
            // Grounds answers to "what do people complain about?" in review text
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
            color: p.color,
            other_colors: colorsOf(p).filter(x => x.id !== p.id).map(x => x.color),
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
            let spoken = args.query ? String(args.query).toLowerCase() : '';
            const specs = {};
            SPEC_WORDS.forEach(({ re, key, value }) => {
                let said = false;
                spoken = spoken.replace(re, () => { said = true; return ' '; });
                if (said && (args[key] === undefined || args[key] === null)) specs[key] = value;
            });
            args = { ...args, ...specs };
            let query = cleanQuery(spoken);
            let color = args.color ? String(args.color).trim().toLowerCase() : '';
            const named = colorWords();
            const spokenColors = query.split(' ').filter(w => named.has(w));
            if (spokenColors.length) {
                query = query.split(' ').filter(w => !named.has(w)).join(' ');
                if (!color) color = spokenColors.join(' ');
            }
            // A word no umbrella has ("something", "flashlight") must not empty the results; the agent is told instead.
            const catalog = App.getProducts().map(searchText);
            const words = query.split(' ').filter(Boolean);
            const ignored = words.filter(w => !catalog.some(t => t.includes(w)));
            query = words.filter(w => !ignored.includes(w)).join(' ');
            if (query) filters.search = query;
            if (color) filters.color = color;
            if (args.brand) {
                // Spoken brands arrive in any case ("Totes", "tumella"); match the catalog's spelling
                const brand = App.getBrands().find(b => b.toLowerCase() === String(args.brand).trim().toLowerCase());
                if (!brand) throw new Error(`Unknown brand "${args.brand}". Brands in the store: ${App.getBrands().join(', ')}.`);
                filters.brand = brand;
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

            const applied = {
                query: query || undefined,
                color: color || undefined,
                brand: filters.brand,
                max_price: filters.maxPrice,
                min_rating: filters.minRating,
                min_wind_mph: filters.minWind,
                max_weight_oz: filters.maxWeight,
                automatic_open: filters.autoOpen,
                sort_by: filters.sortBy,
            };
            const report = {
                total_matches: matches.length,
                query_used: query,
                color_used: color || null,
                filters_applied: JSON.parse(JSON.stringify(applied)),  // drops the unset ones
            };
            if (ignored.length) {
                report.ignored_words = ignored;
                report.ignored_note = 'No umbrella in the store mentions these words, so they were left out of the search. '
                    + 'If they mattered to the user, say the store has nothing like that.';
            }
            if (!matches.length) {
                return { ...report, results: [], note: 'No umbrellas match these filters. Tell the user and offer to relax one of them.' };
            }
            return {
                ...report,
                results: matches.slice(0, MAX_RESULTS).map(summary),
                note: `Positions 1 to ${matches.length} are valid for this search, including ones not listed here; `
                    + 'earlier positions no longer apply.',
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
            ids.forEach(product);  // unknown ids fail before anything changes on screen
            App.closeAllPanels();
            App.compareProducts(ids);
            return compareResult();
        },

        update_compare(args) {
            const current = App.getCompareIds();
            let next;
            if (args.action === 'clear') {
                next = [];
            } else if (args.action === 'remove') {
                if (!current.length) throw new Error('Nothing is being compared, so there is nothing to remove.');
                const byColumn = (args.columns || []).map(c => {
                    const col = Number(c);
                    if (!Number.isInteger(col) || col < 1 || col > current.length) {
                        throw new Error(`Column ${c} does not exist; the comparison has ${current.length} umbrellas.`);
                    }
                    return current[col - 1];
                });
                const gone = [...byColumn, ...(args.product_ids || []).map(String)];
                if (!gone.length) throw new Error('Say which to remove: columns (1 for the leftmost) or product_ids.');
                const missing = gone.find(id => !current.includes(id));
                if (missing) throw new Error(`${product(missing).name} is not in the comparison.`);
                next = current.filter(id => !gone.includes(id));
            } else if (args.action === 'add') {
                const added = [
                    ...(args.positions || []).map(n => atPosition(n).id),
                    ...(args.product_ids || []).map(id => product(id).id),
                ];
                if (!added.length) throw new Error('Say which to add: positions or product_ids.');
                next = [...new Set([...current, ...added])];
                if (next.length > 3) {
                    throw new Error(`At most 3 umbrellas can be compared; ${current.length} already are. Ask which one to remove first.`);
                }
            } else {
                throw new Error(`Unknown action "${args.action}". Use remove, add or clear.`);
            }
            App.compareProducts(next);
            const result = compareResult();
            if (next.length < 2) {
                result.note = next.length
                    ? 'Only one umbrella is left, so the comparison closed. Offer to add another one to compare.'
                    : 'The comparison is empty and closed.';
            }
            return result;
        },

        update_cart(args) {
            const p = target(args);
            const inCart = App.getCartSummary().items.find(i => i.id === p.id);
            const qty = args.quantity === undefined || args.quantity === null ? undefined : Number(args.quantity);
            if (qty !== undefined && (!Number.isInteger(qty) || qty < 0 || qty > 20)) {
                throw new Error(`quantity must be a whole number from 0 to 20, got "${args.quantity}".`);
            }
            if (args.action === 'add') {
                if (qty === 0) throw new Error('quantity for add must be at least 1.');
                App.addToCart(p.id, qty || 1);
            } else if (args.action === 'remove') {
                if (!inCart) throw new Error(`${p.name} is not in the cart, so there is nothing to remove.`);
                App.removeFromCart(p.id);
            } else if (args.action === 'set_quantity') {
                if (qty === undefined) throw new Error('set_quantity needs a quantity.');
                if (inCart) App.updateQty(p.id, qty);
                else if (qty > 0) App.addToCart(p.id, qty);  // "make it two" before it was added
            } else {
                throw new Error(`Unknown action "${args.action}". Use add, remove or set_quantity.`);
            }
            return cartResult();
        },

        checkout(args) {
            let added = null;
            const named = (args.position !== undefined && args.position !== null)
                || (args.product_id !== undefined && args.product_id !== null);
            if (named) {
                // "Check out the TUMELLA": put it in the cart first, then go straight to checkout
                const p = target(args);
                const given = args.quantity !== undefined && args.quantity !== null;
                const qty = given ? Number(args.quantity) : 1;
                if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
                    throw new Error(`quantity must be a whole number from 1 to 20, got "${args.quantity}".`);
                }
                const inCart = App.getCartSummary().items.find(i => i.id === p.id);
                if (!inCart) {
                    App.addToCart(p.id, qty);
                    added = `${qty} × ${p.name}`;
                } else if (given && inCart.qty !== qty) {
                    App.updateQty(p.id, qty);  // "check out two of them" when one is already in the cart
                    added = `now ${qty} × ${p.name}`;
                }
            }
            if (!App.getCartSummary().items.length) {
                throw new Error('The cart is empty. Tell the user and offer to help them find an umbrella.');
            }
            App.closeAllPanels();  // checkout opens on its own, not on top of a detail page or comparison
            App.openCheckout();
            return {
                ...cartResult(),
                added_to_cart: added,
                note: 'Say what is in the order and the total, then ask the user to confirm before calling place_order.',
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

    // latestResults: ids of the latest search in on-screen order (read-only copy, for the agent's memory)
    return { definitions, keyterms, run, latestResults: () => [...latestResults] };
})();
