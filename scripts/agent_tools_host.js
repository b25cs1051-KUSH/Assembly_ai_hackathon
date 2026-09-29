/* Runs the browser's eight tools in Node for scripts/voice_latency.py.
   Set ACTIVE_CATALOG to choose the prepared category bundle and CATALOG_ROOT to read bundles elsewhere. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readline = require('node:readline');

const ROOT = path.join(__dirname, '..');
const CATALOG_ROOT = path.resolve(ROOT, process.env.CATALOG_ROOT || 'data/catalogs');
function load(category) {
    const active = JSON.parse(fs.readFileSync(path.join(CATALOG_ROOT, category, 'active.json')));
    const folder = path.join(CATALOG_ROOT, category, active.version);
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


const catalog = load(process.env.ACTIVE_CATALOG || 'umbrella');
const reply = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
    try {
        const request = JSON.parse(line);
        if (request.definitions) return reply({
            definitions: catalog.tools.definitions(), keyterms: catalog.tools.keyterms(),
        });
        if ('ackFor' in request) return reply({ ack: catalog.tools.ackFor(request.ackFor) });
        reply({ result: await catalog.tools.run(request.name, request.arguments) });
    } catch (error) {
        reply({ error: error.message });
    }
});
