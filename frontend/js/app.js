/* =================================================================
   App — state management, API calls, event wiring for VoiceCart AI
   ================================================================= */

const App = (() => {
    /* ── STATE ──────────────────────────────────────────────────── */
    const state = {
        products: [],
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
            sortBy: 'relevance',
        };
    }

    const SORTERS = {
        relevance: null,  // catalog order
        price_low_to_high: (a, b) => a.price - b.price,
        price_high_to_low: (a, b) => b.price - a.price,
        rating: (a, b) => b.rating - a.rating,
        lightest: (a, b) => a.specs.weight_oz - b.specs.weight_oz,
        most_wind_resistant: (a, b) => b.specs.wind_rating_mph - a.specs.wind_rating_mph,
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
    async function fetchProducts() {
        const res = await fetch('/api/products');
        state.products = await res.json();
        initFilterControls();  // also applies the (reset) filters
    }

    /* Brand list and slider ranges come from the catalog, not hard-coded values */
    function initFilterControls() {
        const brands = [...new Set(state.products.map(p => p.brand))].sort((a, b) => a.localeCompare(b));
        const brandSelect = $('#filter-brand');
        brandSelect.length = 1;  // keep "All Brands"
        brands.forEach(b => brandSelect.add(new Option(b, b)));

        const colorSelect = $('#filter-color');
        colorSelect.length = 1;  // keep "All Colors"
        colorFamilies().forEach(c => colorSelect.add(new Option(c, c.toLowerCase())));

        const maxPrice = Math.max(...state.products.map(p => p.price));
        state.priceCeiling = Math.ceil(maxPrice / 5) * 5;
        $('#filter-price').max = state.priceCeiling;

        const maxWind = Math.max(...state.products.map(p => p.specs.wind_rating_mph));
        $('#filter-wind').max = Math.ceil(maxWind / 5) * 5;

        resetFilters();
    }

    async function fetchCompare(ids) {
        const res = await fetch('/api/products/compare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        return res.json();
    }

    /* ── FILTERS ────────────────────────────────────────────────── */
    function applyFilters() {
        const f = state.filters;
        // Every search word must appear somewhere, in any order ("clear bubble" matches "Clear Bubble Umbrella").
        const words = f.search.toLowerCase().split(/\s+/).filter(Boolean);
        state.filtered = state.products.filter(p => {
            if (f.brand !== 'all' && p.brand !== f.brand) return false;
            if (f.color && !colorMatches(p, f.color)) return false;
            if (p.price > f.maxPrice) return false;
            if (p.specs.wind_rating_mph < f.minWind) return false;
            if (p.rating < f.minRating) return false;
            if (p.specs.weight_oz > f.maxWeight) return false;
            if (f.autoOpen && !p.specs.automatic_open) return false;
            if (words.length) {
                const haystack = `${p.name} ${p.brand} ${p.color} ${p.color_family} ${p.description} ${p.specs.frame_material}`.toLowerCase();
                if (!words.every(w => haystack.includes(w))) return false;
            }
            return true;
        });
        const sorter = SORTERS[f.sortBy];
        if (sorter) state.filtered.sort(sorter);
        UI.renderGrid(state.filtered, state.compareSet);
    }

    /* Moves the filter bar controls to match state.filters (the voice agent sets filters too) */
    function syncFilterControls() {
        const f = state.filters;
        const price = Math.min(f.maxPrice, state.priceCeiling);
        $('#filter-brand').value = f.brand;
        // The select lists color families; a spoken color name that is not one shows as "All Colors"
        $('#filter-color').value = [...$('#filter-color').options].some(o => o.value === f.color) ? f.color : '';
        $('#filter-price').value = price;
        $('#filter-price-label').textContent = `$${price}`;
        $('#filter-wind').value = f.minWind;
        $('#filter-wind-label').textContent = `${f.minWind} mph`;
        // The select only has fixed steps: show the closest one that is not stricter than the filter.
        const ratingSteps = [...$('#filter-rating').options].map(o => +o.value).filter(v => v <= f.minRating);
        $('#filter-rating').value = Math.max(...ratingSteps);
        $('#search-input').value = f.search;
    }

    function resetFilters() {
        state.filters = defaultFilters();
        syncFilterControls();
        applyFilters();
    }

    /* Replaces all filters at once; returns the matching products in display order */
    function setFilters(partial) {
        state.filters = { ...defaultFilters(), ...partial };
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
        UI.renderDetail(p, state.products.filter(x => x.model === p.model));
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
        const what = count > 1 ? 'umbrellas' : 'umbrella';
        state.orders++;
        $('#confirm-title').textContent = state.orders === 1
            ? `Congratulations on your first ${what}!`
            : `Congratulations on your new ${what}!`;
        $('#confirm-message').textContent = `Your ${count > 1 ? `${count} umbrellas are` : 'umbrella is'} on the way.`;
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
            $('#filter-price-label').textContent = `$${e.target.value}`;
            applyFilters();
        });
        $('#filter-wind').addEventListener('input', e => {
            state.filters.minWind = +e.target.value;
            $('#filter-wind-label').textContent = `${e.target.value} mph`;
            applyFilters();
        });
        $('#filter-rating').addEventListener('change', e => { state.filters.minRating = +e.target.value; applyFilters(); });
        $('#filter-reset').addEventListener('click', resetFilters);
        $('#empty-reset').addEventListener('click', resetFilters);

        /* Search */
        let searchTimer;
        $('#search-input').addEventListener('input', e => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => { state.filters.search = e.target.value; applyFilters(); }, 200);
        });

        /* Keyboard shortcut: / to focus search */
        document.addEventListener('keydown', e => {
            if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
                e.preventDefault();
                $('#search-input').focus();
            }
            if (e.key === 'Escape') {
                closeAllPanels();
            }
        });

        /* Header actions */
        $('#compare-btn').addEventListener('click', openCompare);
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
    }

    /* ── INIT ───────────────────────────────────────────────────── */
    async function init() {
        bind();
        await fetchProducts();
    }

    document.addEventListener('DOMContentLoaded', init);

    /* ── PUBLIC API (inline onclick handlers and agent tools) ────── */
    return {
        getProducts: () => state.products,
        getVisible: () => state.filtered,
        getCompareIds: () => [...state.compareSet],
        getBrands: () => [...new Set(state.products.map(p => p.brand))].sort((a, b) => a.localeCompare(b)),
        colorMatches,
        sortOptions: Object.keys(SORTERS),
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
        placeOrder,
        getOpenView,
    };
})();
