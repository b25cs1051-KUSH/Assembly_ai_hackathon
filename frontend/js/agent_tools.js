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
        'one', 'ones', 'please', 'show', 'me', 'some', 'any', 'the', 'a', 'an',
        'i', 'my', 'need', 'want', 'find', 'get', 'looking', 'look', 'for', 'something', 'that', 'with', 'and', 'in', 'of',
        'it', 'is', 'to', 'can', 'you', 'have', 'like', 'good', 'nice', 'really', 'very',
        'under', 'below', 'less', 'than', 'over', 'above', 'around', 'about', 'dollar', 'dollars', 'bucks', 'usd',
        'cheap', 'cheaper', 'cheapest', 'color', 'colour', 'colored', 'coloured',
    ]);

    // Ids of the latest search's matches in display order: "position 1" means the first one on screen now,
    // resolved here rather than left to the model's memory of older searches.
    let latestResults = [];

    /* Shown in the voice dock's tool chip while a tool runs */
    const LABELS = {
        search_products: 'Searching the store',
        show_product: 'Opening product details',
        compare_products: 'Comparing products',
        update_compare: 'Updating the comparison',
        update_cart: 'Updating your cart',
        show_cart: 'Opening your cart',
        checkout: 'Preparing checkout',
        place_order: 'Placing your order',
    };

    /* Built on demand: the brand and product id enums come from the loaded catalog */
    function definitions() {
        const manifest = App.getManifest();
        if (!manifest) throw new Error('Catalog is not loaded');
        const productId = { type: 'string', description: 'Stable product id. Prefer position for numbered search results.' };
        const position = { type: 'integer', minimum: 1, description: 'Number in the latest search, e.g. 1 for first.' };
        const target = { position, product_id: productId };
        if (manifest.variant_value_source) target.variant = { type: 'string', description: 'Requested option of the same product.' };
        const search = {
            query: { type: 'string', description: 'Product keywords; omit requirements already in filters.' },
            max_price: { type: 'number', description: 'Highest listed price in ' + manifest.currency + '.' },
            sort_by: { type: 'string', enum: App.sortOptions, description: 'Result order; default relevance.' },
        };
        const brands = App.getBrands();
        if (brands.length) search.brand = { type: 'string', description: 'Only this brand.',
            ...(brands.length <= 40 ? { enum: brands } : {}) };
        if (manifest.presentation === 'umbrella_demo') search.color = { type: 'string', description: 'Only this color or color family.' };
        if (App.getProducts().some(p => p.rating !== null)) search.min_rating = { type: 'number', description: 'Lowest customer rating, from 1 to 5.' };
        for (const attribute of manifest.attributes) for (const filter of attribute.filters) {
            const schema = { type: attribute.kind === 'number' ? 'number' : attribute.kind === 'boolean' ? 'boolean' : 'string',
                description: filter.description };
            if (attribute.kind === 'enum') {
                const values = [...new Set(App.getProducts().map(p => p.attributes[attribute.key]).filter(v => v !== undefined))];
                if (values.length <= 40) schema.enum = values;
            }
            search[filter.parameter] = schema;
        }
        return [
            { type: 'function', name: 'search_products',
                description: 'Filter the store products and update the grid when the shopper describes or changes requirements.',
                parameters: { type: 'object', properties: search } },
            { type: 'function', name: 'show_product',
                description: 'Open product details and return recorded attributes, reviews and available options.',
                parameters: { type: 'object', properties: target } },
            { type: 'function', name: 'compare_products',
                description: 'Compare two or three products using their recorded values.',
                parameters: { type: 'object', properties: {
                    positions: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 3,
                        description: 'Result numbers in the latest search. Use positions or product_ids.' },
                    product_ids: { type: 'array', items: productId, minItems: 2, maxItems: 3,
                        description: 'Stable product ids to compare.' },
                } } },
            { type: 'function', name: 'update_compare',
                description: 'Add, remove or clear products in the current comparison.',
                parameters: { type: 'object', properties: {
                    action: { type: 'string', enum: ['remove', 'add', 'clear'] },
                    columns: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Column numbers to remove.' },
                    positions: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Latest search result numbers to add.' },
                    product_ids: { type: 'array', items: productId, description: 'Product ids to add or remove.' },
                }, required: ['action'] } },
            { type: 'function', name: 'update_cart',
                description: 'Add, remove or set a product quantity in the cart.',
                parameters: { type: 'object', properties: {
                    action: { type: 'string', enum: ['add', 'remove', 'set_quantity'] }, ...target,
                    quantity: { type: 'integer', description: 'Quantity; defaults to one for add.' },
                }, required: ['action'] } },
            { type: 'function', name: 'show_cart',
                description: 'Open the cart and return its items and total.',
                parameters: { type: 'object', properties: {} } },
            { type: 'function', name: 'checkout',
                description: 'Open simulated checkout; optionally add a named product to the cart first.',
                parameters: { type: 'object', properties: { ...target,
                    quantity: { type: 'integer', minimum: 1, description: 'How many of the named product.' },
                } } },
            { type: 'function', name: 'place_order',
                description: 'Show simulated order confirmation only after the shopper confirms the total.',
                parameters: { type: 'object', properties: {
                    user_confirmed: { type: 'boolean', description: 'True only after explicit shopper confirmation.' },
                }, required: ['user_confirmed'] } },
        ];
    }

    function keyterms() {
        const manifest = App.getManifest();
        return ['VoiceCart', manifest.display_name, ...App.getBrands()].slice(0, 100);
    }

    function optionalNumber(args, key) {
        if (args[key] === undefined || args[key] === null) return undefined;
        const value = Number(args[key]);
        if (!Number.isFinite(value) || value < 0) throw new Error(key + ' must be a nonnegative number.');
        return value;
    }

    function product(id) {
        const found = App.getProducts().find(item => item.id === String(id));
        if (!found) throw new Error('No product with id ' + id + '. Use an id from search_products.');
        return found;
    }

    function numbered() {
        return latestResults.length ? latestResults : App.getVisible().map(item => item.id);
    }

    function atPosition(number) {
        const pos = Number(number);
        const ids = numbered();
        if (!ids.length) throw new Error('No products are on screen. Call search_products first.');
        if (!Number.isInteger(pos) || pos < 1 || pos > ids.length) {
            throw new Error('Out of range: the latest search has ' + ids.length + ' results. Tell the user number '
                + number + ' is out of range and ask if they want number ' + ids.length + ', the last one, instead.');
        }
        return product(ids[pos - 1]);
    }

    function variantsOf(item) {
        return item.variant_group ? App.getProducts().filter(other => other.variant_group === item.variant_group) : [item];
    }

    function inVariant(item, requested) {
        const variants = variantsOf(item);
        const want = String(requested).toLowerCase().trim();
        const match = variants.find(other => String(other.variant_value).toLowerCase() === want)
            || variants.find(other => String(other.variant_value).toLowerCase().includes(want));
        if (match) return match;
        throw new Error(item.name + ' is not offered in ' + requested + '. Available options: '
            + variants.map(other => other.variant_value || other.name).join(', ') + '.');
    }

    function target(args) {
        let item;
        if (args.position !== undefined && args.position !== null) item = atPosition(args.position);
        else if (args.product_id !== undefined && args.product_id !== null) item = product(args.product_id);
        else throw new Error('Give position or product_id.');
        return args.variant || args.color ? inVariant(item, args.variant || args.color) : item;
    }

    function positionOf(id) {
        const index = numbered().indexOf(id);
        return index < 0 ? null : index + 1;
    }

    async function comparisonForCurrent(data = null) {
        const ids = App.getCompareIds();
        if (ids.length < 2) {
            return { products: ids.map((id, index) => ({ id, name: product(id).name, column: index + 1,
                position: positionOf(id) })), matrix: [] };
        }
        data = data || await App.compareProducts(ids);
        if (!data) throw new Error('The comparison was superseded by a newer request.');
        return { ...data, products: data.products.map((item, index) => ({
            ...item, column: index + 1, position: positionOf(item.id),
        })) };
    }

    function variantWords() {
        const words = new Set();
        App.getProducts().forEach(item => String(item.variant_value || '').toLowerCase()
            .split(/[^a-z]+/).forEach(word => { if (word.length > 2) words.add(word); }));
        return words;
    }

    const ACTION_WORDS = /\b(compare|comparison|cart|basket|add|remove|take out|check ?out|buy|purchase|quantity|reviews?|details?|first one|second one|third one|last one)\b/;
    const SEARCH_WORDS = /\b(need|want|looking|find|search|show|under|below|less than|price|cheap|products?|items?)\b/;
    function ackFor(text) {
        const said = String(text || '').toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim();
        if (!said || /\b(place|confirm)\b/.test(said)) return null;
        if (ACTION_WORDS.test(said)) return 'action';
        const manifest = App.getManifest();
        const names = new Set([...variantWords(), ...App.getBrands().map(name => name.toLowerCase()),
            ...manifest.display_name.toLowerCase().split(/\s+/),
            ...manifest.attributes.flatMap(rule => rule.label.toLowerCase().split(/\s+/))]);
        if (SEARCH_WORDS.test(said) || said.split(' ').some(word => names.has(word))) return 'search_products';
        return null;
    }

    function stem(word) {
        if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3).replace(/(.)\1$/, '$1');
        if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
        return word;
    }

    function cleanQuery(query) {
        const manifest = App.getManifest();
        const filler = new Set([...FILLER, ...manifest.display_name.toLowerCase().split(/\s+/),
            ...manifest.singular_name.toLowerCase().split(/\s+/)]);
        return String(query).toLowerCase().split(/[^a-z0-9]+/)
            .filter(word => word && !filler.has(word) && !/^\d+$/.test(word))
            .map(stem).join(' ');
    }

    function searchText(item) {
        return CatalogRuntime.searchText(item, App.getManifest());
    }

    function details(item) {
        return {
            position: positionOf(item.id), id: item.id, name: item.name, brand: item.brand,
            price: item.price, currency: item.currency, rating: item.rating,
            review_count: item.review_count, attributes: item.attributes,
            variants: variantsOf(item).filter(other => other.id !== item.id)
                .map(other => ({ id: other.id, option: other.variant_value })),
            pros: item.pros, cons: item.cons, reviews_summary: item.reviews_summary,
            critical_reviews: (item.reviews || []).filter(review => review.rating <= 4)
                .sort((a, b) => a.rating - b.rating).slice(0, 3)
                .map(review => ({ rating: review.rating, text: review.text })),
            top_reviews: (item.reviews || []).filter(review => review.rating === 5).slice(0, 2)
                .map(review => ({ rating: review.rating, text: review.text })),
        };
    }

    function cartResult() {
        const cart = App.getCartSummary();
        return { items: cart.items.map(item => ({ id: item.id, name: item.name, quantity: item.qty, line_total: item.lineTotal })),
            item_count: cart.itemCount, subtotal: cart.subtotal, tax: cart.tax, total: cart.total,
            currency: App.getManifest().currency };
    }

    function summary(item, index) {
        return {
            position: index + 1, id: item.id, name: item.name, brand: item.brand,
            price: item.price, currency: item.currency, rating: item.rating,
            attributes: item.attributes,
            variants: variantsOf(item).filter(other => other.id !== item.id).map(other => other.variant_value),
            best_point: (item.pros || [])[0] || null,
            main_drawback: (item.cons || [])[0] || null,
        };
    }

    /* ── HANDLERS ───────────────────────────────────────────────── */
    const handlers = {
        search_products(args) {
            const manifest = App.getManifest();
            const filters = { attributeFilters: {} };
            let spoken = String(args.query || '').toLowerCase();
            for (const alias of [...manifest.search_aliases].sort((a, b) => b.phrase.length - a.phrase.length)) {
                const escaped = alias.phrase.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp('\\b' + escaped.replace(/\s+/g, '[\\s-]+') + '\\b', 'gi');
                if (pattern.test(spoken)) {
                    spoken = spoken.replace(pattern, ' ');
                    if (args[alias.parameter] === undefined) filters.attributeFilters[alias.parameter] = alias.value;
                }
            }
            let query = cleanQuery(spoken);
            let color = args.color ? String(args.color).trim().toLowerCase() : '';
            if (manifest.presentation === 'umbrella_demo') {
                const named = variantWords();
                const spokenColors = query.split(' ').filter(word => named.has(word));
                if (spokenColors.length) {
                    query = query.split(' ').filter(word => !named.has(word)).join(' ');
                    if (!color) color = spokenColors.join(' ');
                }
            }
            const texts = App.getProducts().map(searchText);
            const words = query.split(' ').filter(Boolean);
            const ignored = words.filter(word => !texts.some(text => text.includes(word)));
            query = words.filter(word => !ignored.includes(word)).join(' ');
            if (query) filters.search = query;
            if (color) filters.color = color;
            if (args.brand) {
                const brand = App.getBrands().find(value => value.toLowerCase() === String(args.brand).trim().toLowerCase());
                if (!brand) throw new Error('Unknown brand ' + args.brand + '. Brands: ' + App.getBrands().join(', '));
                filters.brand = brand;
            }
            if (args.sort_by) {
                if (!App.sortOptions.includes(args.sort_by)) throw new Error('Unknown sort_by: ' + args.sort_by);
                filters.sortBy = args.sort_by;
            }
            const maxPrice = optionalNumber(args, 'max_price');
            const minRating = optionalNumber(args, 'min_rating');
            if (maxPrice !== undefined) filters.maxPrice = maxPrice;
            if (minRating !== undefined) filters.minRating = minRating;
            for (const attribute of manifest.attributes) for (const rule of attribute.filters) {
                const value = args[rule.parameter];
                if (value === undefined || value === null) continue;
                if (attribute.kind === 'number') filters.attributeFilters[rule.parameter] = optionalNumber(args, rule.parameter);
                else if (attribute.kind === 'boolean') {
                    if (typeof value !== 'boolean') throw new Error(rule.parameter + ' must be true or false.');
                    filters.attributeFilters[rule.parameter] = value;
                } else filters.attributeFilters[rule.parameter] = String(value);
            }

            App.closeAllPanels();
            UI.highlightCard(null);
            const matches = App.setFilters(filters);
            latestResults = matches.map(item => item.id);
            UI.markPositions(matches.slice(0, HIGHLIGHTED).map(item => item.id));
            document.getElementById('products-section').scrollIntoView({ behavior: 'smooth' });
            const applied = { query: query || undefined, color: color || undefined,
                brand: filters.brand, max_price: filters.maxPrice, min_rating: filters.minRating,
                ...filters.attributeFilters, sort_by: filters.sortBy };
            const report = { total_matches: matches.length, query_used: query, color_used: color || null,
                filters_applied: JSON.parse(JSON.stringify(applied)) };
            if (ignored.length) {
                report.ignored_words = ignored;
                report.ignored_note = 'No product mentions these words, so they were left out. If they mattered, explain that the store has no such product.';
            }
            if (!matches.length) return { ...report, results: [], note: 'No products match. Offer to relax one requirement.' };
            return { ...report, results: matches.slice(0, MAX_RESULTS).map(summary),
                note: 'Positions 1 to ' + matches.length + ' are valid in this search; earlier positions no longer apply.' };
        },

        show_product(args) {
            const p = target(args);
            App.closeAllPanels();
            App.openDetail(p.id);
            UI.highlightCard(p.id);
            return details(p);
        },

        async compare_products(args) {
            const picked = args.positions && args.positions.length
                ? args.positions.map(n => atPosition(n).id)
                : (args.product_ids || []).map(String);
            const ids = [...new Set(picked)];
            if (ids.length < 2 || ids.length > 3) {
                throw new Error(`compare_products needs 2 or 3 different products (positions or product_ids), got ${ids.length}.`);
            }
            ids.forEach(product);  // unknown ids fail before anything changes on screen
            App.closeAllPanels();
            const data = await App.compareProducts(ids);
            return comparisonForCurrent(data);
        },

        async update_compare(args) {
            const current = App.getCompareIds();
            let next;
            if (args.action === 'clear') {
                next = [];
            } else if (args.action === 'remove') {
                if (!current.length) throw new Error('Nothing is being compared, so there is nothing to remove.');
                const byColumn = (args.columns || []).map(c => {
                    const col = Number(c);
                    if (!Number.isInteger(col) || col < 1 || col > current.length) {
                        throw new Error(`Column ${c} does not exist; the comparison has ${current.length} products.`);
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
                    throw new Error(`At most 3 products can be compared; ${current.length} already are. Ask which one to remove first.`);
                }
            } else {
                throw new Error(`Unknown action "${args.action}". Use remove, add or clear.`);
            }
            const data = await App.compareProducts(next);
            const result = await comparisonForCurrent(data);
            if (next.length < 2) {
                result.note = next.length
                    ? 'Only one product is left, so the comparison closed. Offer to add another one to compare.'
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

        show_cart() {
            App.closeAllPanels();  // the cart opens on its own, not on top of a detail page or comparison
            App.openCart();
            const result = cartResult();
            if (!result.items.length) result.note = 'The cart is empty. Tell the user and offer to help them find a product.';
            return result;
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
                throw new Error('The cart is empty. Tell the user and offer to help them find a product.');
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
    return { definitions, keyterms, run, ackFor, latestResults: () => [...latestResults] };
})();
