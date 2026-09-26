/* Checks agent_tools.js against the real catalog: spoken search wording and "the first one" after a new search.
   App is a stub using the same filter rule as app.js applyFilters. Run: node scripts/test_agent_tools.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const products = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/products.json'), 'utf8'));
const text = p => `${p.name} ${p.brand} ${p.color} ${p.color_family} ${p.description} ${p.specs.frame_material}`.toLowerCase();
// Same rule as app.js colorMatches
function colorMatches(p, spoken) {
    const norm = t => String(t || '').toLowerCase().replace(/\bgrey\b/g, 'gray');
    const words = norm(spoken).split(/[^a-z]+/).filter(Boolean);
    const haystack = `${norm(p.color)} ${norm(p.color_family)}`;
    return words.every(w => haystack.includes(w));
}

let filtered = products;
let opened = null;
let outlined = 'none';
let compareIds = [];
let compareOpen = false;
let cart = [];              // { id, qty }
let checkoutOpen = false;
const App = {
    getProducts: () => products,
    getVisible: () => filtered,
    getBrands: () => [...new Set(products.map(p => p.brand))].sort((a, b) => a.localeCompare(b)),
    sortOptions: ['relevance'],
    closeAllPanels() { checkoutOpen = false; },
    colorMatches,
    setFilters(f) {  // same rules as app.js applyFilters
        const words = (f.search || '').toLowerCase().split(/\s+/).filter(Boolean);
        filtered = products.filter(p => (!f.brand || f.brand === 'all' || p.brand === f.brand)
            && (!f.color || colorMatches(p, f.color))
            && p.price <= (f.maxPrice ?? Infinity)
            && p.specs.wind_rating_mph >= (f.minWind ?? 0)
            && p.rating >= (f.minRating ?? 0)
            && p.specs.weight_oz <= (f.maxWeight ?? Infinity)
            && (!f.autoOpen || p.specs.automatic_open)
            && words.every(w => text(p).includes(w)));
        return filtered;
    },
    openDetail(id) { opened = id; },
    compareProducts(ids) { compareIds = ids.map(String); compareOpen = compareIds.length >= 2; },
    getCompareIds: () => [...compareIds],
    addToCart(id, qty = 1) {
        const item = cart.find(i => i.id === id);
        if (item) item.qty += qty; else cart.push({ id, qty });
    },
    removeFromCart(id) { cart = cart.filter(i => i.id !== id); },
    updateQty(id, qty) { const item = cart.find(i => i.id === id); if (item) item.qty = qty; },
    openCheckout() { checkoutOpen = true; },
    isCheckoutOpen: () => checkoutOpen,
    placeOrder() { cart = []; checkoutOpen = false; return 'VC-TEST'; },
    getCartSummary() {
        const items = cart.map(i => {
            const p = products.find(x => x.id === i.id);
            return { id: i.id, name: p.name, qty: i.qty, lineTotal: p.price * i.qty };
        });
        const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
        return { items, itemCount: items.reduce((s, i) => s + i.qty, 0), subtotal, tax: subtotal * 0.08, total: subtotal * 1.08 };
    },
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
    const beforeSearch = await run('show_product', { position: 2 });
    check('before any search, positions count through the grid on screen', beforeSearch.id === products[1].id, `got ${beforeSearch.id}`);

    const yellowIds = products.filter(p => text(p).includes('yellow')).map(p => p.id);
    const blueIds = products.filter(p => text(p).includes('blue')).map(p => p.id);

    const y = await run('search_products', { query: 'yellow umbrellas' });
    check('"yellow umbrellas" finds the yellow products', JSON.stringify(y.results.map(r => r.id)) === JSON.stringify(yellowIds.slice(0, 5)) && y.total_matches === yellowIds.length,
        `want ${yellowIds}, got ${y.results.map(r => r.id)} (query_used "${y.query_used}")`);
    check('a color word in the query becomes the color filter', y.query_used === '' && y.color_used === 'yellow', `got query "${y.query_used}", color "${y.color_used}"`);

    const s = await run('search_products', { query: 'show me some umbrellas please' });
    check('a query of only filler words is no text filter', s.total_matches === products.length, `got ${s.total_matches}`);

    // Natural speech: words no umbrella has, and spec words, must not empty or narrow a search wrongly
    const kid = await run('search_products', { query: 'something for my kid' });
    const kidsId = products.find(p => /kids/i.test(p.name)).id;
    check('"something for my kid" finds the kids umbrella', kid.total_matches > 0 && kid.results.some(r => r.id === kidsId),
        `got ${kid.total_matches} (query_used "${kid.query_used}")`);

    const windproofIds = products.filter(p => p.price <= 30 && p.specs.wind_rating_mph >= 50).map(p => p.id);
    const wp = await run('search_products', { query: 'windproof', max_price: 30, min_wind_mph: 50 });
    check('"windproof" under 30 is the wind filter, not the word', wp.query_used === ''
        && JSON.stringify(wp.results.map(r => r.id)) === JSON.stringify(windproofIds.slice(0, 5)) && wp.total_matches === windproofIds.length,
        `want ${windproofIds}, got ${wp.results.map(r => r.id)} (query_used "${wp.query_used}")`);
    check('the G4Free golf umbrella is among them', wp.results.some(r => r.brand === 'G4Free'), `got ${wp.results.map(r => r.brand)}`);
    const wpOnly = await run('search_products', { query: 'windproof umbrella', max_price: 30 });
    check('"windproof" alone sets min_wind_mph 50 and reports it', wpOnly.filters_applied.min_wind_mph === 50
        && wpOnly.filters_applied.max_price === 30 && wpOnly.total_matches === windproofIds.length, `got ${JSON.stringify(wpOnly.filters_applied)}`);

    const lightTravelIds = products.filter(p => p.specs.weight_oz <= 14 && text(p).includes('travel')).map(p => p.id);
    const lt = await run('search_products', { query: 'light one for travel' });
    check('"light one for travel" is max 14 oz plus "travel"', lt.query_used === 'travel' && lt.filters_applied.max_weight_oz === 14
        && lt.total_matches === lightTravelIds.length && lightTravelIds.length > 0,
        `want ${lightTravelIds}, got ${filtered.map(p => p.id)} (${JSON.stringify(lt.filters_applied)})`);
    const travelling = await run('search_products', { query: 'travelling' });
    check('"travelling" matches "travel"', travelling.query_used === 'travel' && travelling.total_matches > 0, `got "${travelling.query_used}"`);

    const auto = await run('search_products', { query: 'auto open' });
    check('"auto open" is the automatic_open filter', auto.filters_applied.automatic_open === true && auto.query_used === '',
        `got ${JSON.stringify(auto.filters_applied)}`);

    const yl = await run('search_products', { query: 'yellow' });
    check('"yellow" is the color filter', yl.color_used === 'yellow' && yl.total_matches === yellowIds.length, `got ${yl.total_matches}`);

    const odd = await run('search_products', { query: 'flashlight' });
    check('a word no umbrella has is reported, not searched', odd.total_matches === products.length
        && JSON.stringify(odd.ignored_words) === '["flashlight"]', `got ${odd.total_matches}, ignored ${odd.ignored_words}`);

    const b = await run('search_products', { query: 'blue ones' });
    check('"blue ones" finds the blue products', b.total_matches === blueIds.length, `want ${blueIds.length}, got ${b.total_matches}`);
    check('a new search clears the old outline', outlined === null, `outline still on ${outlined}`);

    const first = await run('show_product', { position: 1 });
    check('position 1 after a second search is that search\'s first result', first.id === blueIds[0] && opened === blueIds[0] && outlined === blueIds[0],
        `want ${blueIds[0]}, got ${first.id} (opened ${opened}, outlined ${outlined})`);
    check('show_product reports the position', first.position === 1, `got ${first.position}`);

    const oob = await error(run('show_product', { position: blueIds.length + 1 }));
    check('an out-of-range position gives a specific error', oob && oob.includes(`the latest search has ${blueIds.length}`), `got ${oob}`);
    check('the out-of-range error tells the agent to offer the last one',
        oob && oob.includes(`number ${blueIds.length + 1} is out of range`) && oob.includes(`number ${blueIds.length}, the last one`), `got ${oob}`);

    // Compare: remove by column, add, and the modal closing below two
    await run('search_products', {});
    await run('compare_products', { positions: [1, 2, 3] });
    const [c1, c2, c3] = products.slice(0, 3).map(p => p.id);
    const removed = await run('update_compare', { action: 'remove', columns: [2] });
    check('update_compare remove by column takes out that column', JSON.stringify(removed.products.map(p => p.id)) === JSON.stringify([c1, c3]) && compareOpen,
        `got ${removed.products.map(p => p.id)}, open ${compareOpen}`);
    check('compare results carry column numbers', removed.products.map(p => p.column).join() === '1,2', `got ${removed.products.map(p => p.column)}`);
    const added = await run('update_compare', { action: 'add', positions: [2] });
    check('update_compare add puts one back', added.products.length === 3 && compareIds.includes(c2), `got ${compareIds}`);
    const full = await error(run('update_compare', { action: 'add', positions: [4] }));
    check('adding a fourth gives a specific error', full && full.includes('At most 3'), `got ${full}`);
    const removedById = await run('update_compare', { action: 'remove', product_ids: [c1, c2] });
    check('removing down to one closes the comparison and says so', removedById.products.length === 1 && !compareOpen && /closed/.test(removedById.note),
        `got ${removedById.products.length}, open ${compareOpen}, note ${removedById.note}`);
    const notIn = await error(run('update_compare', { action: 'remove', product_ids: [c1] }));
    check('removing a product that is not compared gives a specific error', notIn && notIn.includes('not in the comparison'), `got ${notIn}`);
    await run('update_compare', { action: 'clear' });
    check('clear empties the comparison', compareIds.length === 0 && !compareOpen, `got ${compareIds}`);

    // Checkout of a named umbrella: added to the cart, then checkout opens, then the order can be placed
    const emptyCheckout = await error(run('checkout', {}));
    check('checkout with an empty cart and no product gives a specific error', emptyCheckout && emptyCheckout.includes('cart is empty'), `got ${emptyCheckout}`);
    const co = await run('checkout', { position: 1 });
    check('checkout with a position adds it and opens checkout',
        co.items.length === 1 && co.items[0].id === c1 && co.added_to_cart && checkoutOpen, `got ${JSON.stringify(co)}`);
    const again = await run('checkout', { position: 1 });
    check('checkout of something already in the cart does not add it twice', again.items[0].quantity === 1 && again.added_to_cart === null,
        `got ${JSON.stringify(again.items)}`);
    const placed = await run('place_order', { user_confirmed: true });
    check('place_order works right after checkout', placed.order_number === 'VC-TEST', `got ${JSON.stringify(placed)}`);

    const setQty = await run('update_cart', { action: 'set_quantity', position: 2, quantity: 2 });
    check('set_quantity on a product not in the cart adds that many', setQty.items.length === 1 && setQty.items[0].quantity === 2,
        `got ${JSON.stringify(setQty.items)}`);
    cart = [];

    // Colors: each of the 15 umbrellas comes in one color, so asking for another gives a specific error
    const tumella = products.find(p => p.model === 'TUMELLA Windproof Travel Umbrella');
    const inRed = await error(run('show_product', { product_id: tumella.id, color: 'red' }));
    check('a color the umbrella does not come in says which color it comes in',
        inRed && inRed.includes('only comes in Yellow'), `got ${inRed}`);
    const inYellow = await run('show_product', { product_id: tumella.id, color: 'yellow' });
    check('asking for the color it comes in opens that umbrella', inYellow.id === tumella.id && opened === tumella.id,
        `got ${inYellow.id} (${inYellow.color})`);
    check('details list no other colors', Array.isArray(inYellow.other_colors) && inYellow.other_colors.length === 0,
        `got ${JSON.stringify(inYellow.other_colors)}`);
    const pink = await run('search_products', { color: 'pink' });
    check('search by color returns only that color', pink.total_matches > 0 && filtered.every(p => p.color_family === 'Pink' || /pink/i.test(p.color)),
        `got ${filtered.map(p => p.color).join(', ')}`);
    check('search results list other colors', Array.isArray(pink.results[0].other_colors), `got ${JSON.stringify(pink.results[0])}`);
    const redCart = await error(run('update_cart', { action: 'add', product_id: tumella.id, color: 'red' }));
    check('update_cart in a color it does not come in gives the same error', redCart && redCart.includes('only comes in Yellow'),
        `got ${redCart}`);
    cart = [];

    await run('search_products', { query: 'blue ones' });

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
