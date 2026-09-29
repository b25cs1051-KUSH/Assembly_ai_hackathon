/* Cross-category contract test for the eight browser tools. Run: node scripts/test_agent_tools.js */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
function load(category, base = 'data/catalogs') {
    const active = JSON.parse(fs.readFileSync(path.join(ROOT, base, category, 'active.json')));
    const folder = path.join(ROOT, base, category, active.version);
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json')));
    const products = JSON.parse(fs.readFileSync(path.join(folder, 'products.json')));
    let visible = products;
    let compareIds = [];
    let cart = [];
    let checkoutOpen = false;
    let opened = null;
    const UI = { markPositions() {}, highlightCard() {}, showToolChip() {}, hideToolChip() {} };
    const App = {
        getManifest: () => manifest, getProducts: () => products, getVisible: () => visible,
        getBrands: () => [...new Set(products.map(p => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
        sortOptions: manifest.presentation === 'umbrella_demo'
            ? ['relevance', 'price_low_to_high', 'price_high_to_low', 'rating', 'lightest', 'most_wind_resistant']
            : ['relevance', 'price_low_to_high', 'price_high_to_low', 'rating'],
        closeAllPanels() { checkoutOpen = false; },
        setFilters(filters) {
            visible = products.filter(product => context.CatalogRuntime.matches(product, manifest, filters));
            return visible;
        },
        openDetail(id) { opened = id; },
        async compareProducts(ids) {
            compareIds = ids.map(String);
            if (compareIds.length < 2) return;
            return {
                version: active.version,
                products: compareIds.map(id => {
                    const product = products.find(p => p.id === id);
                    return { id, name: product.name, image_url: product.image_url };
                }),
                matrix: [{ key: 'price', field: 'Price', values: compareIds.map(id => String(products.find(p => p.id === id).price)),
                    best_indexes: [0], direction: 'lower' }],
            };
        },
        getCompareIds: () => [...compareIds],
        addToCart(id, qty = 1) { const found = cart.find(item => item.id === id); if (found) found.qty += qty; else cart.push({ id, qty }); },
        removeFromCart(id) { cart = cart.filter(item => item.id !== id); },
        updateQty(id, qty) { if (qty <= 0) return this.removeFromCart(id); cart.find(item => item.id === id).qty = qty; },
        getCartSummary() {
            const items = cart.map(item => {
                const product = products.find(p => p.id === item.id);
                return { id: item.id, name: product.name, qty: item.qty, lineTotal: +(product.price * item.qty).toFixed(2) };
            });
            const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
            return { items, itemCount: items.reduce((sum, item) => sum + item.qty, 0), subtotal,
                tax: +(subtotal * 0.08).toFixed(2), total: +(subtotal * 1.08).toFixed(2) };
        },
        openCart() {}, openCheckout() { checkoutOpen = true; }, isCheckoutOpen: () => checkoutOpen,
        placeOrder() { cart = []; checkoutOpen = false; return 'VC-TEST'; },
    };
    const context = { App, UI, console, document: { getElementById: () => ({ scrollIntoView() {} }) } };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/js/catalog_runtime.js'), 'utf8') +
        '\nglobalThis.CatalogRuntime = CatalogRuntime;', context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/js/agent_tools.js'), 'utf8') +
        '\nglobalThis.AgentTools = AgentTools;', context);
    return { tools: context.AgentTools, products, manifest, getOpened: () => opened, getCompareIds: () => compareIds };
}

(async () => {
    const umbrellas = load('umbrella');
    const dry = load('dry_fruits', 'tests/fixtures/catalogs');
    const names = defs => Array.from(defs, item => item.name);
    const expected = ['search_products', 'show_product', 'compare_products', 'update_compare',
        'update_cart', 'show_cart', 'checkout', 'place_order'];
    assert.deepEqual(names(umbrellas.tools.definitions()), expected);
    assert.deepEqual(names(dry.tools.definitions()), expected);
    const umbrellaSearch = umbrellas.tools.definitions()[0].parameters.properties;
    const drySearch = dry.tools.definitions()[0].parameters.properties;
    assert.ok(umbrellaSearch.min_wind_mph);
    assert.ok(drySearch.min_pack_weight_g);
    assert.equal(drySearch.min_wind_mph, undefined);
    assert.ok(!drySearch.sort_by.enum.includes('most_wind_resistant'));

    const wind = await umbrellas.tools.run('search_products', { query: 'windproof umbrella', max_price: 30 });
    assert.equal(wind.filters_applied.min_wind_mph, 50);
    assert.ok(wind.total_matches > 0);
    const yellow = await umbrellas.tools.run('search_products', { query: 'yellow umbrellas' });
    assert.equal(yellow.color_used, 'yellow');
    const detail = await umbrellas.tools.run('show_product', { position: 1 });
    assert.equal(detail.id, yellow.results[0].id);
    assert.equal(umbrellas.getOpened(), detail.id);
    assert.ok(detail.attributes.wind_rating_mph !== undefined);

    const almonds = await dry.tools.run('search_products', { query: 'almonds', min_pack_weight_g: 300 });
    assert.equal(almonds.total_matches, 1);
    assert.equal(almonds.results[0].attributes.pack_weight_g, 500);
    const india = await dry.tools.run('search_products', { origin: 'India' });
    assert.equal(india.total_matches, 1);
    assert.ok(india.results[0].name.includes('Cashews'));
    await dry.tools.run('search_products', {});
    const compared = await dry.tools.run('compare_products', { positions: [1, 2] });
    assert.equal(compared.products.length, 2);
    assert.equal(compared.matrix[0].direction, 'lower');
    assert.deepEqual(Array.from(compared.matrix[0].best_indexes), [0]);
    const updated = await dry.tools.run('update_compare', { action: 'remove', columns: [2] });
    assert.equal(updated.products.length, 1);
    assert.equal(dry.getCompareIds().length, 1);
    const cart = await dry.tools.run('update_cart', { action: 'add', position: 1, quantity: 2 });
    assert.equal(cart.item_count, 2);
    assert.equal((await dry.tools.run('show_cart', {})).item_count, 2);
    const checkout = await dry.tools.run('checkout', {});
    assert.ok(checkout.total > 0);
    await assert.rejects(dry.tools.run('place_order', { user_confirmed: false }));
    assert.equal((await dry.tools.run('place_order', { user_confirmed: true })).order_number, 'VC-TEST');
    console.log('PASS: eight tools, umbrella search/variants, dry-fruit fixture filters, shared comparison, cart and checkout');
})().catch(error => { console.error(error); process.exitCode = 1; });
