/* =================================================================
   App — state management, API calls, event wiring for VoiceCart AI
   ================================================================= */

const App = (() => {
    /* ── STATE ──────────────────────────────────────────────────── */
    const state = {
        products: [],
        manifest: null,
        version: null,
        filtered: [],
        cart: [],            // { id, qty }
        compareSet: new Set(),
        filters: defaultFilters(),
        detailId: null,      // product shown in the detail drawer
        orders: 0,           // orders placed this visit (for the congratulations text)
        priceCeiling: 100,   // slider max, derived from the catalog
    };

    /* ── HELPERS ────────────────────────────────────────────────── */
    function defaultFilters() {
        return {
            brand: 'all',
            color: '',           // spoken color or a color family, matched by colorMatches
            maxPrice: Infinity,
            minWind: 0,
            minRating: 0,
            maxWeight: Infinity,
            autoOpen: false,     // true → only automatic-open umbrellas
            search: '',
            attributeFilters: {},
            sortBy: 'relevance',
        };
    }

    const SORTERS = {
        relevance: null,  // catalog order
        price_low_to_high: (a, b) => a.price - b.price,
        price_high_to_low: (a, b) => b.price - a.price,
        rating: (a, b) => b.rating - a.rating,
        lightest: (a, b) => (a.attributes?.weight_oz ?? Infinity) - (b.attributes?.weight_oz ?? Infinity),
        most_wind_resistant: (a, b) => (b.attributes?.wind_rating_mph ?? -Infinity) - (a.attributes?.wind_rating_mph ?? -Infinity),
    };

    const $ = sel => document.querySelector(sel);
    const productById = id => state.products.find(p => String(p.id) === String(id));

    /* "blue" matches Navy Blue and Light Blue, "navy" matches Navy Blue, "pink" matches a pink family pattern:
       every spoken word must appear in the product's color name or color family. */
    function colorMatches(p, spoken) {
        const norm = t => String(t || '').toLowerCase().replace(/\bgrey\b/g, 'gray');
        const words = norm(spoken).split(/[^a-z]+/).filter(Boolean);
        const haystack = `${norm(p.color)} ${norm(p.color_family)}`;
        return words.every(w => haystack.includes(w));
    }

    const colorFamilies = () => [...new Set(state.products.map(p => p.color_family).filter(Boolean))].sort();

    /* ── API ────────────────────────────────────────────────────── */
    let readyPromise;
    async function fetchProducts() {
        const res = await fetch('/api/catalog');
        if (!res.ok) throw new Error('Could not load the store catalog');
        const catalog = await res.json();
        state.manifest = catalog.manifest;
        state.version = catalog.version;
        state.products = catalog.products;
        configureCategoryCopy();
        initFilterControls();
        document.dispatchEvent(new Event('catalog:ready'));
    }

    function configureCategoryCopy() {
        if (state.manifest.presentation === 'umbrella_demo') return;
        const label = state.manifest.display_name;
        document.title = 'VoiceCart AI \u2014 ' + label;
        document.querySelector('meta[name="description"]').content =
            'Voice-powered shopping for ' + label.toLowerCase() + '.';
        $('#search-input').placeholder = 'Search ' + label.toLowerCase() + '\u2026';
        $('#admin-btn').title = 'Add a product';
        $('.hero-deco').textContent = '\u2726';
        $('#products-title').textContent = 'All ' + label;
        $('#empty-state p').textContent = 'No ' + label.toLowerCase() + ' match your filters.';
        const questions = state.manifest.guide_questions || [];
        if (questions.length) {
            $('.hero-accent').textContent = '“' + questions[0] + '”';
            document.querySelectorAll('#agent-hints .hint-chip').forEach((chip, i) => {
                chip.textContent = '“' + (questions[i] || questions[0]) + '”';
            });
        }
        const labels = state.manifest.attributes.map(a => a.label).slice(0, 4)
            .concat(['Review-backed answers', 'Just ask out loud', 'Compare by voice', 'Hands-free checkout']);
        document.querySelectorAll('.marquee-track > span:not(.marquee-dot)').forEach((node, i) => {
            node.textContent = labels[i % labels.length];
        });
    }

    function showNewProduct(product) {
        // A live voice session holds its tool definitions from session.update.
        // End it before exposing a newly published catalog version.
        VoiceAgent.stop();
        state.products.push(product);
        if (product.catalog_version) state.version = product.catalog_version;
        initFilterControls();
        $('#products-section').scrollIntoView({ behavior: 'smooth' });
    }

    /* The original umbrella controls stay intact; other categories use the same styled control groups. */
    function initFilterControls() {
        const brands = [...new Set(state.products.map(p => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        const brandSelect = $('#filter-brand');
        brandSelect.length = 1;
        brands.forEach(b => brandSelect.add(new Option(b, b)));
        brandSelect.parentElement.style.display = brands.length ? '' : 'none';

        const colorSelect = $('#filter-color');
        colorSelect.length = 1;
        colorFamilies().forEach(c => colorSelect.add(new Option(c, c.toLowerCase())));
        const umbrella = state.manifest.presentation === 'umbrella_demo';
        colorSelect.parentElement.style.display = umbrella ? '' : 'none';
        $('#filter-wind').parentElement.style.display = umbrella ? '' : 'none';
        $('#filter-rating').parentElement.style.display = umbrella ? '' : 'none';
        document.querySelectorAll('[data-dynamic-filter]').forEach(node => node.remove());

        const maxPrice = Math.max(0, ...state.products.map(p => p.price));
        state.priceCeiling = Math.max(5, Math.ceil(maxPrice / 5) * 5);
        $('#filter-price').max = state.priceCeiling;
        if (umbrella) {
            const maxWind = Math.max(0, ...state.products.map(p => Number(p.attributes.wind_rating_mph || 0)));
            $('#filter-wind').max = Math.ceil(maxWind / 5) * 5;
        } else {
            const container = $('#filters-inner');
            for (const attribute of state.manifest.attributes) {
                for (const filter of attribute.filters) {
                    if (!filter.ui_label) continue;
                    const group = document.createElement('div');
                    group.className = 'filter-group';
                    group.dataset.dynamicFilter = filter.parameter;
                    const label = document.createElement('label');
                    const id = 'category-filter-' + filter.parameter;
                    label.htmlFor = id;
                    label.textContent = filter.ui_label;
                    const values = state.products.map(p => p.attributes[attribute.key]).filter(v => v !== undefined && v !== null);
                    let control;
                    if (attribute.kind === 'number') {
                        control = document.createElement('input');
                        control.type = 'range';
                        control.min = '0';
                        control.max = String(Math.max(1, Math.ceil(Math.max(...values.map(Number)) / (filter.ui_step || 1)) * (filter.ui_step || 1)));
                        control.step = String(filter.ui_step || 1);
                        control.value = filter.operator === 'max' ? control.max : '0';
                        const shown = document.createElement('span');
                        shown.className = 'category-filter-value';
                        group.append(label, control, shown);
                    } else {
                        control = document.createElement('select');
                        control.add(new Option('Any', ''));
                        const options = attribute.kind === 'boolean' ? [true, false] : [...new Set(values)].sort();
                        options.forEach(value => control.add(new Option(
                            typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value), String(value))));
                        group.append(label, control);
                    }
                    control.id = id;
                    control.addEventListener(attribute.kind === 'number' ? 'input' : 'change', () => {
                        state.filters.attributeFilters[filter.parameter] = control.value;
                        syncFilterControls();
                        applyFilters();
                    });
                    container.insertBefore(group, $('#filter-reset'));
                }
            }
        }
        resetFilters();
    }

    async function fetchCompare(ids) {
        const res = await fetch('/api/products/compare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, version: state.version }),
        });
        if (!res.ok) throw new Error('Could not compare products from this catalog version');
        return res.json();
    }

    /* ── FILTERS ────────────────────────────────────────────────── */
    function applyFilters() {
        const f = state.filters;
        if (!state.manifest) return;
        state.filtered = state.products.filter(p => {
            if (!CatalogRuntime.matches(p, state.manifest, f)) return false;
            if (state.manifest.presentation === 'umbrella_demo') {
                if ((p.attributes.wind_rating_mph ?? 0) < f.minWind) return false;
                if ((p.attributes.weight_oz ?? Infinity) > f.maxWeight) return false;
                if (f.autoOpen && p.attributes.automatic_open !== true) return false;
            }
            return true;
        });
        const sorter = SORTERS[f.sortBy];
        if (sorter) state.filtered.sort(sorter);
        UI.renderGrid(state.filtered, state.compareSet);
    }

    function syncFilterControls() {
        const f = state.filters;
        const price = Math.min(f.maxPrice, state.priceCeiling);
        $('#filter-brand').value = f.brand;
        $('#filter-color').value = [...$('#filter-color').options].some(o => o.value === f.color) ? f.color : '';
        $('#filter-price').value = price;
        $('#filter-price-label').textContent = state.manifest.presentation === 'umbrella_demo'
            ? '$' + price : CatalogRuntime.money(price, state.manifest.currency);
        const wind = f.attributeFilters.min_wind_mph ?? f.minWind;
        $('#filter-wind').value = wind;
        $('#filter-wind-label').textContent = wind + ' mph';
        const ratingSteps = [...$('#filter-rating').options].map(o => +o.value).filter(v => v <= f.minRating);
        $('#filter-rating').value = Math.max(...ratingSteps);
        $('#search-input').value = f.search;
        document.querySelectorAll('[data-dynamic-filter]').forEach(group => {
            const control = group.querySelector('input, select');
            const parameter = group.dataset.dynamicFilter;
            const chosen = f.attributeFilters[parameter];
            control.value = chosen === undefined ? (control.type === 'range' && parameter.startsWith('max_') ? control.max : (control.type === 'range' ? '0' : '')) : String(chosen);
            const shown = group.querySelector('.category-filter-value');
            if (shown) {
                const rule = state.manifest.attributes.find(a => a.filters.some(filter => filter.parameter === parameter));
                shown.textContent = control.value + (rule.unit ? ' ' + rule.unit : '');
            }
        });
    }

    function resetFilters() {
        state.filters = defaultFilters();
        syncFilterControls();
        applyFilters();
    }

    /* Replaces all filters at once; returns the matching products in display order */
    function setFilters(partial) {
        state.filters = { ...defaultFilters(), ...partial };
        if (state.manifest.presentation === 'umbrella_demo') {
            const attributes = state.filters.attributeFilters;
            if (attributes.min_wind_mph !== undefined) state.filters.minWind = Number(attributes.min_wind_mph);
            if (attributes.max_weight_oz !== undefined) state.filters.maxWeight = Number(attributes.max_weight_oz);
            if (attributes.automatic_open !== undefined) state.filters.autoOpen = attributes.automatic_open === true;
        }
        syncFilterControls();
        applyFilters();
        return state.filtered;
    }

    /* ── COMPARE ────────────────────────────────────────────────── */
    function toggleCompare(id) {
        if (state.compareSet.has(id)) {
            state.compareSet.delete(id);
        } else {
            if (state.compareSet.size >= 3) {
                UI.toast('Compare up to 3 products');
                return;
            }
            state.compareSet.add(id);
        }
        UI.updateBadge('compare-badge', state.compareSet.size);
        $('#compare-btn').disabled = state.compareSet.size < 2;
        UI.renderGrid(state.filtered, state.compareSet);
    }

    let compareRequest = 0;  // only the latest comparison may render
    async function openCompare() {
        if (state.compareSet.size < 2) return;
        const request = ++compareRequest;
        const data = await fetchCompare([...state.compareSet]);
        if (request !== compareRequest) return;
        UI.renderCompare(data);
        UI.openPanel('compare-overlay', 'compare-modal');
        return data;
    }

    /* Replaces the compare selection (used by the voice agent): opens the modal with 2 or 3, closes it with fewer */
    function compareProducts(ids) {
        state.compareSet = new Set(ids.map(String));
        UI.updateBadge('compare-badge', state.compareSet.size);
        $('#compare-btn').disabled = state.compareSet.size < 2;
        UI.renderGrid(state.filtered, state.compareSet);
        if (state.compareSet.size >= 2) return openCompare();
        compareRequest++;  // a comparison still loading must not reopen the modal
        UI.closePanel('compare-overlay', 'compare-modal');
        return Promise.resolve();
    }

    /* ── DETAIL ─────────────────────────────────────────────────── */
    function openDetail(id) {
        const p = productById(id);
        if (!p) return;
        state.detailId = p.id;
        UI.renderDetail(p, p.variant_group ? state.products.filter(x => x.variant_group === p.variant_group) : [p]);
        UI.openPanel('detail-overlay', 'detail-drawer');
    }

    /* ── CART ────────────────────────────────────────────────────── */
    function addToCart(id, qty = 1) {
        const existing = state.cart.find(i => i.id === id);
        if (existing) {
            existing.qty += qty;
        } else {
            state.cart.push({ id, qty });
        }
        syncCart();
        UI.bumpBadge('cart-badge');
        const p = productById(id);
        UI.toast(`${qty > 1 ? `${qty} × ` : ''}${p ? p.name : 'Item'} added to cart`);
    }

    function removeFromCart(id) {
        state.cart = state.cart.filter(i => i.id !== id);
        syncCart();
    }

    function updateQty(id, qty) {
        if (qty <= 0) { removeFromCart(id); return; }
        const item = state.cart.find(i => i.id === id);
        if (!item) return;
        item.qty = qty;
        syncCart();
    }

    function syncCart() {
        const totalQty = state.cart.reduce((s, i) => s + i.qty, 0);
        UI.updateBadge('cart-badge', totalQty);
        UI.renderCart(state.cart, state.products);
        if (isCheckoutOpen()) UI.renderCheckout(state.cart, state.products);
    }

    /* Same numbers the cart drawer and checkout show (8% tax, free shipping) */
    function getCartSummary() {
        const items = state.cart.map(i => {
            const p = productById(i.id);
            return { id: i.id, name: p.name, qty: i.qty, lineTotal: +(p.price * i.qty).toFixed(2) };
        });
        const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
        const tax = subtotal * 0.08;
        return {
            items,
            itemCount: items.reduce((s, i) => s + i.qty, 0),
            subtotal: +subtotal.toFixed(2),
            tax: +tax.toFixed(2),
            total: +(subtotal + tax).toFixed(2),
        };
    }

    function openCart() {
        syncCart();
        UI.openPanel('cart-overlay', 'cart-drawer');
    }

    /* ── CHECKOUT ───────────────────────────────────────────────── */
    // True from the moment checkout is requested: the modal itself opens 300 ms later, after the cart slides away.
    let checkoutOpening = false;
    let checkoutTimer;
    function openCheckout() {
        checkoutOpening = true;
        UI.closePanel('cart-overlay', 'cart-drawer');
        clearTimeout(checkoutTimer);
        checkoutTimer = setTimeout(() => {
            checkoutOpening = false;
            UI.renderCheckout(state.cart, state.products);
            UI.openPanel('checkout-overlay', 'checkout-modal');
        }, 300);
    }

    function isCheckoutOpen() {
        return checkoutOpening || $('#checkout-modal').classList.contains('open');
    }

    /* Returns the order number shown on the confirmation screen */
    function placeOrder() {
        const orderNumber = `VC-${Date.now().toString().slice(-6)}`;
        const count = state.cart.reduce((s, i) => s + i.qty, 0);
        const what = state.manifest.presentation === 'umbrella_demo' ? (count > 1 ? 'umbrellas' : 'umbrella') : (count > 1 ? 'items' : 'item');
        state.orders++;
        $('#confirm-title').textContent = state.orders === 1
            ? `Congratulations on your first ${what}!`
            : `Congratulations on your new ${what}!`;
        $('#confirm-message').textContent = state.manifest.presentation === 'umbrella_demo'
            ? `Your ${count > 1 ? `${count} umbrellas are` : 'umbrella is'} on the way.`
            : `Your ${count > 1 ? `${count} items are` : 'item is'} on the way.`;
        $('#confirm-order-number').textContent = `Order number ${orderNumber}`;
        state.cart = [];
        UI.closePanel('checkout-overlay', 'checkout-modal');
        syncCart();
        setTimeout(() => {
            UI.openPanel('confirm-overlay', 'confirm-modal');
            UI.confetti();
        }, 300);
        return orderNumber;
    }

    /* What is open right now, for the voice agent's memory between sessions */
    function getOpenView() {
        const open = id => $(id).classList.contains('open');
        if (open('#checkout-modal')) return { view: 'checkout' };
        if (open('#compare-modal')) return { view: 'compare', ids: [...state.compareSet] };
        if (open('#detail-drawer')) return { view: 'detail', id: state.detailId };
        if (open('#cart-drawer')) return { view: 'cart' };
        return { view: 'grid' };
    }

    /* ── EVENT WIRING ───────────────────────────────────────────── */
    function bind() {
        /* Filters */
        $('#filter-brand').addEventListener('change', e => { state.filters.brand = e.target.value; applyFilters(); });
        $('#filter-color').addEventListener('change', e => { state.filters.color = e.target.value; applyFilters(); });
        $('#filter-price').addEventListener('input', e => {
            state.filters.maxPrice = +e.target.value;
            $('#filter-price-label').textContent = App.formatPrice(Number(e.target.value));
            applyFilters();
        });
        $('#filter-wind').addEventListener('input', e => {
            state.filters.minWind = +e.target.value;
            $('#filter-wind-label').textContent = `${e.target.value} mph`;
            applyFilters();
        });
        $('#filter-rating').addEventListener('change', e => { state.filters.minRating = +e.target.value; applyFilters(); });
        $('#filter-reset').addEventListener('click', resetFilters);
        $('#filters-toggle').addEventListener('click', () => {
            const open = $('#filters-bar').classList.toggle('expanded');
            $('#filters-toggle').setAttribute('aria-expanded', String(open));
        });
        $('#empty-reset').addEventListener('click', resetFilters);

        /* Search */
        let searchTimer;
        $('#search-input').addEventListener('input', e => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => { state.filters.search = e.target.value; applyFilters(); }, 200);
        });

        /* Keyboard shortcut: / to focus search */
        document.addEventListener('keydown', e => {
            if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.activeElement.isContentEditable) {
                e.preventDefault();
                $('#search-input').focus();
            }
            if (e.key === 'Escape') {
                closeAllPanels();
            }
        });

        /* Header actions */
        $('#compare-btn').addEventListener('click', () => openCompare().catch(err => UI.toast(err.message)));
        $('#cart-btn').addEventListener('click', openCart);

        /* Close buttons */
        $('#detail-close').addEventListener('click', () => UI.closePanel('detail-overlay', 'detail-drawer'));
        $('#detail-overlay').addEventListener('click', () => UI.closePanel('detail-overlay', 'detail-drawer'));
        $('#compare-close').addEventListener('click', () => UI.closePanel('compare-overlay', 'compare-modal'));
        $('#compare-overlay').addEventListener('click', () => UI.closePanel('compare-overlay', 'compare-modal'));
        $('#cart-close').addEventListener('click', () => UI.closePanel('cart-overlay', 'cart-drawer'));
        $('#cart-overlay').addEventListener('click', () => UI.closePanel('cart-overlay', 'cart-drawer'));
        $('#checkout-close').addEventListener('click', () => UI.closePanel('checkout-overlay', 'checkout-modal'));
        $('#checkout-overlay').addEventListener('click', () => UI.closePanel('checkout-overlay', 'checkout-modal'));
        $('#confirm-done').addEventListener('click', () => UI.closePanel('confirm-overlay', 'confirm-modal'));
        $('#confirm-overlay').addEventListener('click', () => UI.closePanel('confirm-overlay', 'confirm-modal'));

        /* Checkout */
        $('#checkout-btn').addEventListener('click', openCheckout);

        /* Logo / home */
        $('#logo-link').addEventListener('click', e => {
            e.preventDefault();
            resetFilters();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    function closeAllPanels() {
        clearTimeout(checkoutTimer);  // a checkout still sliding in must not reopen over the new view
        checkoutOpening = false;
        UI.closePanel('detail-overlay', 'detail-drawer');
        UI.closePanel('compare-overlay', 'compare-modal');
        UI.closePanel('cart-overlay', 'cart-drawer');
        UI.closePanel('checkout-overlay', 'checkout-modal');
        UI.closePanel('confirm-overlay', 'confirm-modal');
        if ($('#admin-modal').classList.contains('open')) Admin.close();
    }

    /* ── INIT ───────────────────────────────────────────────────── */
    async function init() {
        bind();
        readyPromise = fetchProducts();
        try { await readyPromise; } catch (err) { UI.toast(err.message); }
    }

    document.addEventListener('DOMContentLoaded', init);

    /* ── PUBLIC API (inline onclick handlers and agent tools) ────── */
    return {
        showNewProduct,
        getProducts: () => state.products,
        getManifest: () => state.manifest,
        getVersion: () => state.version,
        whenReady: () => readyPromise || Promise.reject(new Error('Catalog is not ready')),
        formatPrice: value => CatalogRuntime.money(value, state.manifest?.currency || 'USD'),
        getVisible: () => state.filtered,
        getCompareIds: () => [...state.compareSet],
        getBrands: () => [...new Set(state.products.map(p => p.brand))].sort((a, b) => a.localeCompare(b)),
        colorMatches,
        get sortOptions() { return state.manifest?.presentation === 'umbrella_demo' ? Object.keys(SORTERS) : ['relevance', 'price_low_to_high', 'price_high_to_low', 'rating']; },
        setFilters,
        toggleCompare,
        openDetail,
        addToCart,
        removeFromCart,
        updateQty,
        getCartSummary,
        compareProducts,
        closeAllPanels,
        openCheckout,
        isCheckoutOpen,
        openCart,
        placeOrder,
        getOpenView,
    };
})();
