/* Checks agent_tools.js against the real catalog: spoken search wording and "the first one" after a new search.
   App is a stub using the same filter rule as app.js applyFilters. Run: node scripts/test_agent_tools.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const products = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/products.json'), 'utf8'));
const text = p => `${p.name} ${p.brand} ${p.description} ${p.specs.frame_material}`.toLowerCase();

let filtered = [];
let opened = null;
let outlined = 'none';
const App = {
    getProducts: () => products,
    getBrands: () => [...new Set(products.map(p => p.brand))].sort((a, b) => a.localeCompare(b)),
    sortOptions: ['relevance'],
    closeAllPanels() {},
    setFilters(f) {  // same word rule as app.js applyFilters
        const words = (f.search || '').toLowerCase().split(/\s+/).filter(Boolean);
        filtered = products.filter(p => words.every(w => text(p).includes(w)));
        return filtered;
    },
    openDetail(id) { opened = id; },
    compareProducts() {},
    getCartSummary: () => ({ items: [], itemCount: 0, subtotal: 0, tax: 0, total: 0 }),
};
const UI = { markPositions() {}, highlightCard(id) { outlined = id; }, showToolChip() {}, hideToolChip() {} };
const ctx = { App, UI, console, document: { getElementById: () => ({ scrollIntoView() {} }) } };
vm.createContext(ctx);
vm.runInContext(`${fs.readFileSync(path.join(ROOT, 'frontend/js/agent_tools.js'), 'utf8')}\nglobalThis.AgentTools = AgentTools;`, ctx);
const { run } = ctx.AgentTools;

let failed = 0;
function check(name, ok, detail) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`);
}
async function error(p) { try { await p; return null; } catch (e) { return e.message; } }

(async () => {
    const yellowIds = products.filter(p => text(p).includes('yellow')).map(p => p.id);
    const blueIds = products.filter(p => text(p).includes('blue')).map(p => p.id);

    const y = await run('search_products', { query: 'yellow umbrellas' });
    check('"yellow umbrellas" finds the yellow products', JSON.stringify(y.results.map(r => r.id)) === JSON.stringify(yellowIds.slice(0, 5)) && y.total_matches === yellowIds.length,
        `want ${yellowIds}, got ${y.results.map(r => r.id)} (query_used "${y.query_used}")`);
    check('query_used is the cleaned query', y.query_used === 'yellow', `got "${y.query_used}"`);

    const s = await run('search_products', { query: 'show me some umbrellas please' });
    check('a query of only filler words is no text filter', s.total_matches === products.length, `got ${s.total_matches}`);

    const b = await run('search_products', { query: 'blue ones' });
    check('"blue ones" finds the blue products', b.total_matches === blueIds.length, `want ${blueIds.length}, got ${b.total_matches}`);
    check('a new search clears the old outline', outlined === null, `outline still on ${outlined}`);

    const first = await run('show_product', { position: 1 });
    check('position 1 after a second search is that search\'s first result', first.id === blueIds[0] && opened === blueIds[0] && outlined === blueIds[0],
        `want ${blueIds[0]}, got ${first.id} (opened ${opened}, outlined ${outlined})`);
    check('show_product reports the position', first.position === 1, `got ${first.position}`);

    const oob = await error(run('show_product', { position: blueIds.length + 1 }));
    check('an out-of-range position gives a specific error', oob && oob.includes(`the latest search has ${blueIds.length}`), `got ${oob}`);

    if (blueIds.length >= 2) {
        const cmp = await run('compare_products', { positions: [1, 2] });
        check('compare by positions uses the latest search', JSON.stringify(cmp.products.map(p => p.id)) === JSON.stringify(blueIds.slice(0, 2)),
            `got ${cmp.products.map(p => p.id)}`);
    }

    const byId = await run('show_product', { product_id: yellowIds[0] });
    check('product_id still works, with position null when not in the latest search',
        byId.id === yellowIds[0] && byId.position === (blueIds.includes(yellowIds[0]) ? blueIds.indexOf(yellowIds[0]) + 1 : null), `got ${byId.id} / ${byId.position}`);

    const none = await error(run('show_product', {}));
    check('neither position nor product_id gives a specific error', none && none.includes('position'), `got ${none}`);

    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
})();
