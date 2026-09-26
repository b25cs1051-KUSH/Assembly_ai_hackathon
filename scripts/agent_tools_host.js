/* Runs frontend/js/agent_tools.js outside the browser for scripts/voice_latency.py, so latency runs send the
   page's exact tool definitions and tool results. One JSON request per stdin line, one JSON reply per stdout line:
     {"definitions": true}              → the tools array the page sends in session.update
     {"name": "...", "arguments": {...}} → {"result": ...} or {"error": "..."}
   App is a stub using the same filter rule as app.js applyFilters. */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const products = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/products.json'), 'utf8'));
const text = p => `${p.name} ${p.brand} ${p.color} ${p.color_family} ${p.description} ${p.specs.frame_material}`.toLowerCase();
function colorMatches(p, spoken) {
    const norm = t => String(t || '').toLowerCase().replace(/\bgrey\b/g, 'gray');
    const haystack = `${norm(p.color)} ${norm(p.color_family)}`;
    return norm(spoken).split(/[^a-z]+/).filter(Boolean).every(w => haystack.includes(w));
}
const SORTERS = {
    relevance: null,
    price_low_to_high: (a, b) => a.price - b.price,
    price_high_to_low: (a, b) => b.price - a.price,
    rating: (a, b) => b.rating - a.rating,
    lightest: (a, b) => a.specs.weight_oz - b.specs.weight_oz,
    most_wind_resistant: (a, b) => b.specs.wind_rating_mph - a.specs.wind_rating_mph,
};

let filtered = products;
let cart = [];
let compareIds = [];
let checkoutOpen = false;
const App = {
    getProducts: () => products,
    getVisible: () => filtered,
    getBrands: () => [...new Set(products.map(p => p.brand))].sort((a, b) => a.localeCompare(b)),
    sortOptions: Object.keys(SORTERS),
    colorMatches,
    closeAllPanels() { checkoutOpen = false; },
    setFilters(f) {
        const words = (f.search || '').toLowerCase().split(/\s+/).filter(Boolean);
        filtered = products.filter(p => (!f.brand || p.brand === f.brand)
            && (!f.color || colorMatches(p, f.color))
            && p.price <= (f.maxPrice ?? Infinity)
            && p.specs.wind_rating_mph >= (f.minWind ?? 0)
            && p.rating >= (f.minRating ?? 0)
            && p.specs.weight_oz <= (f.maxWeight ?? Infinity)
            && (!f.autoOpen || p.specs.automatic_open)
            && words.every(w => text(p).includes(w)));
        if (SORTERS[f.sortBy]) filtered.sort(SORTERS[f.sortBy]);
        return filtered;
    },
    openDetail() {},
    compareProducts(ids) { compareIds = ids.map(String); },
    getCompareIds: () => [...compareIds],
    addToCart(id, qty = 1) { const i = cart.find(x => x.id === id); if (i) i.qty += qty; else cart.push({ id, qty }); },
    removeFromCart(id) { cart = cart.filter(i => i.id !== id); },
    updateQty(id, qty) { const i = cart.find(x => x.id === id); if (i) i.qty = qty; },
    openCheckout() { checkoutOpen = true; },
    isCheckoutOpen: () => checkoutOpen,
    placeOrder() { cart = []; return 'VC-TEST'; },
    getCartSummary() {
        const items = cart.map(i => {
            const p = products.find(x => x.id === i.id);
            return { id: i.id, name: p.name, qty: i.qty, lineTotal: +(p.price * i.qty).toFixed(2) };
        });
        const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
        return { items, itemCount: items.reduce((s, i) => s + i.qty, 0), subtotal, tax: +(subtotal * 0.08).toFixed(2), total: +(subtotal * 1.08).toFixed(2) };
    },
};
const UI = { markPositions() {}, highlightCard() {}, showToolChip() {}, hideToolChip() {} };
const ctx = { App, UI, console, document: { getElementById: () => ({ scrollIntoView() {} }) } };
vm.createContext(ctx);
vm.runInContext(`${fs.readFileSync(path.join(ROOT, 'frontend/js/agent_tools.js'), 'utf8')}\nglobalThis.AgentTools = AgentTools;`, ctx);

const reply = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
readline.createInterface({ input: process.stdin }).on('line', async line => {
    const req = JSON.parse(line);
    if (req.definitions) { reply({ definitions: ctx.AgentTools.definitions(), keyterms: ctx.AgentTools.keyterms() }); return; }
    try {
        reply({ result: await ctx.AgentTools.run(req.name, req.arguments) });
    } catch (e) {
        reply({ error: e.message });
    }
});
