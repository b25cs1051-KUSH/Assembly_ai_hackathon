/* =================================================================
   AgentTools — client-side tools the voice agent can call.
   Each handler changes the UI and returns compact JSON for the agent.
   Error messages are read by the model word for word, so keep them specific.
   Docs: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools
   ================================================================= */

const AgentTools = (() => {
    const MAX_RESULTS = 5;

    /* Built on demand: the brand enum comes from the loaded catalog */
    function definitions() {
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
                        brand: { type: 'string', enum: App.getBrands(), description: 'Only this brand.' },
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
        };
    }

    /* ── HANDLERS ───────────────────────────────────────────────── */
    const handlers = {
        search_products(args) {
            const filters = {};
            if (args.query) filters.search = String(args.query).trim();
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

            const matches = App.setFilters(filters);
            document.getElementById('products-section').scrollIntoView({ behavior: 'smooth' });

            if (!matches.length) {
                return {
                    total_matches: 0,
                    results: [],
                    note: 'No umbrellas match these filters. Tell the user and offer to relax one of them.',
                };
            }
            return { total_matches: matches.length, results: matches.slice(0, MAX_RESULTS).map(summary) };
        },
    };

    /* Runs one tool call; throws an Error with a model-readable message on bad input */
    async function run(name, args) {
        const handler = handlers[name];
        if (!handler) throw new Error(`Unknown tool "${name}".`);
        return handler(args || {});
    }

    return { definitions, keyterms, run };
})();
