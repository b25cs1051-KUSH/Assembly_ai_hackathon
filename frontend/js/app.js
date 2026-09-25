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
        filters: {
            brand: 'all',
            maxPrice: Infinity,
            minWind: 0,
            minRating: 0,
            search: '',
        },
        priceCeiling: 100,   // slider max, derived from the catalog
    };

    /* ── HELPERS ────────────────────────────────────────────────── */
    const $ = sel => document.querySelector(sel);
    const productById = id => state.products.find(p => String(p.id) === String(id));

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
        state.filtered = state.products.filter(p => {
            if (f.brand !== 'all' && p.brand !== f.brand) return false;
            if (p.price > f.maxPrice) return false;
            if (p.specs.wind_rating_mph < f.minWind) return false;
            if (p.rating < f.minRating) return false;
            if (f.search) {
                const q = f.search.toLowerCase();
                const haystack = `${p.name} ${p.brand} ${p.description} ${p.specs.frame_material}`.toLowerCase();
                if (!haystack.includes(q)) return false;
            }
            return true;
        });
        UI.renderGrid(state.filtered, state.compareSet);
    }

    function resetFilters() {
        state.filters = { brand: 'all', maxPrice: state.priceCeiling, minWind: 0, minRating: 0, search: '' };
        $('#filter-brand').value = 'all';
        $('#filter-price').value = state.priceCeiling;
        $('#filter-price-label').textContent = `$${state.priceCeiling}`;
        $('#filter-wind').value = 0;
        $('#filter-wind-label').textContent = '0 mph';
        $('#filter-rating').value = 0;
        $('#search-input').value = '';
        applyFilters();
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

    async function openCompare() {
        if (state.compareSet.size < 2) return;
        const data = await fetchCompare([...state.compareSet]);
        UI.renderCompare(data);
        UI.openPanel('compare-overlay', 'compare-modal');
    }

    /* ── DETAIL ─────────────────────────────────────────────────── */
    function openDetail(id) {
        const p = productById(id);
        if (!p) return;
        UI.renderDetail(p);
        UI.openPanel('detail-overlay', 'detail-drawer');
    }

    /* ── CART ────────────────────────────────────────────────────── */
    function addToCart(id) {
        const existing = state.cart.find(i => i.id === id);
        if (existing) {
            existing.qty += 1;
        } else {
            state.cart.push({ id, qty: 1 });
        }
        syncCart();
        const p = productById(id);
        UI.toast(`${p ? p.name : 'Item'} added to cart`);
    }

    function removeFromCart(id) {
        state.cart = state.cart.filter(i => i.id !== id);
        syncCart();
    }

    function updateQty(id, qty) {
        if (qty <= 0) { removeFromCart(id); return; }
        const item = state.cart.find(i => i.id === id);
        if (item) item.qty = qty;
        syncCart();
    }

    function syncCart() {
        const totalQty = state.cart.reduce((s, i) => s + i.qty, 0);
        UI.updateBadge('cart-badge', totalQty);
        UI.renderCart(state.cart, state.products);
    }

    function openCart() {
        syncCart();
        UI.openPanel('cart-overlay', 'cart-drawer');
    }

    /* ── CHECKOUT ───────────────────────────────────────────────── */
    function openCheckout() {
        UI.closePanel('cart-overlay', 'cart-drawer');
        setTimeout(() => {
            UI.renderCheckout(state.cart, state.products);
            UI.openPanel('checkout-overlay', 'checkout-modal');
        }, 300);
    }

    function placeOrder() {
        UI.closePanel('checkout-overlay', 'checkout-modal');
        setTimeout(() => {
            UI.openPanel('confirm-overlay', 'confirm-modal');
            state.cart = [];
            syncCart();
        }, 300);
    }

    /* ── EVENT WIRING ───────────────────────────────────────────── */
    function bind() {
        /* Filters */
        $('#filter-brand').addEventListener('change', e => { state.filters.brand = e.target.value; applyFilters(); });
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

        /* Hero browse */
        $('#hero-browse-btn').addEventListener('click', () => {
            document.getElementById('products-section').scrollIntoView({ behavior: 'smooth' });
        });

        /* Logo / home */
        $('#logo-link').addEventListener('click', e => {
            e.preventDefault();
            resetFilters();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    function closeAllPanels() {
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

    /* ── PUBLIC API (used by inline onclick handlers) ────────────── */
    return {
        toggleCompare,
        openDetail,
        addToCart,
        removeFromCart,
        updateQty,
        placeOrder,
    };
})();
