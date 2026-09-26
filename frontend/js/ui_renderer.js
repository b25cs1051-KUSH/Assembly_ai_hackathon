/* =================================================================
   UI Renderer — all DOM rendering logic for VoiceCart AI
   ================================================================= */

const UI = (() => {
    /* ── helper ─────────────────────────────────────────────────── */
    function stars(rating) {
        const full = Math.floor(rating);
        const half = rating % 1 >= 0.3 ? 1 : 0;
        const empty = 5 - full - half;
        return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
    }

    function $(sel) { return document.querySelector(sel); }

    /* ── PRODUCT GRID ───────────────────────────────────────────── */
    function renderGrid(products, compareSet) {
        const grid = $('#product-grid');
        const empty = $('#empty-state');
        const count = $('#result-count');

        if (!products.length) {
            grid.innerHTML = '';
            grid.style.display = 'none';
            empty.style.display = 'block';
            count.textContent = '';
            return;
        }

        empty.style.display = 'none';
        grid.style.display = 'grid';
        count.textContent = `${products.length} product${products.length > 1 ? 's' : ''}`;

        grid.innerHTML = products.map(p => `
            <article class="product-card" data-id="${p.id}" onclick="App.openDetail('${p.id}')">
                <div class="card-image-wrap">
                    <img src="${p.image_url}" alt="${p.name}" loading="lazy">
                    <span class="card-brand-badge">${p.brand}</span>
                    <button class="card-compare-toggle ${compareSet.has(p.id) ? 'active' : ''}"
                            data-compare-id="${p.id}" title="Compare"
                            onclick="event.stopPropagation(); App.toggleCompare('${p.id}')">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                    </button>
                </div>
                <div class="card-body">
                    <div class="card-name">${p.name}</div>
                    <div class="card-meta">
                        <span class="card-price">$${p.price.toFixed(2)}</span>
                        <span class="card-rating"><span class="star-icon">★</span> ${p.rating} (${p.review_count})</span>
                    </div>
                    <div class="card-desc">${p.description}</div>
                </div>
                <div class="card-actions">
                    <button class="btn-add-cart" onclick="event.stopPropagation(); App.addToCart('${p.id}')">Add to Cart</button>
                </div>
            </article>
        `).join('');
    }

    /* ── PRODUCT DETAIL DRAWER ──────────────────────────────────── */
    /* colors: every color of this umbrella (the product itself included), in catalog order */
    function renderDetail(product, colors = [product]) {
        const body = $('#detail-body');
        const colorsHTML = colors.length > 1 ? `
            <div class="detail-colors">
                <span class="detail-colors-label">Color: <strong>${product.color}</strong></span>
                <div class="detail-color-options">
                    ${colors.map(c => `
                        <button class="color-option ${c.id === product.id ? 'active' : ''}"
                                ${c.id === product.id ? 'aria-current="true"' : `onclick="App.openDetail('${c.id}')"`}>
                            ${c.color} <span class="color-option-price">$${c.price.toFixed(2)}</span>
                        </button>
                    `).join('')}
                </div>
            </div>` : '';
        const reviewsHTML = (product.reviews || []).map(r => `
            <div class="review-card">
                <div class="review-header">
                    <span class="review-author">${r.name}</span>
                    <span class="review-date">${r.date}</span>
                </div>
                <div class="review-stars">${stars(r.rating)}</div>
                <div class="review-text">${r.text}</div>
            </div>
        `).join('');

        body.innerHTML = `
            <div class="detail-content">
                <div class="detail-head">
                    <img class="detail-thumb" src="${product.image_url}" alt="${product.name}">
                    <div class="detail-head-text">
                        <div class="detail-brand">${product.brand}</div>
                        <h2 class="detail-name">${product.name}</h2>
                        <div class="detail-price-row">
                            <span class="detail-price">$${product.price.toFixed(2)}</span>
                            <span class="detail-rating"><span class="star-icon">★</span> ${product.rating} · ${product.review_count} reviews</span>
                        </div>
                    </div>
                </div>
                ${colorsHTML}
                <p class="detail-desc">${product.description}</p>
                <button class="btn-primary detail-add-btn" onclick="App.addToCart('${product.id}')">Add to Cart</button>

                <div class="proscons">
                    <div class="proscons-col pros">
                        <h3>Pros</h3>
                        <ul>${(product.pros || []).map(t => `<li>${t}</li>`).join('')}</ul>
                    </div>
                    <div class="proscons-col cons">
                        <h3>Cons</h3>
                        <ul>${(product.cons || []).map(t => `<li>${t}</li>`).join('')}</ul>
                    </div>
                </div>

                <div class="specs-section">
                    <h3>Specifications</h3>
                    <div class="specs-grid">
                        <div class="spec-item">
                            <div class="spec-label">Frame Material</div>
                            <div class="spec-value">${product.specs.frame_material}</div>
                        </div>
                        <div class="spec-item">
                            <div class="spec-label">Canopy Size</div>
                            <div class="spec-value">${product.specs.canopy_size_inches}"</div>
                        </div>
                        <div class="spec-item">
                            <div class="spec-label">Wind Rating</div>
                            <div class="spec-value">${product.specs.wind_rating_mph} mph</div>
                        </div>
                        <div class="spec-item">
                            <div class="spec-label">Weight</div>
                            <div class="spec-value">${product.specs.weight_oz} oz</div>
                        </div>
                        <div class="spec-item">
                            <div class="spec-label">Auto-Open</div>
                            <div class="spec-value">${product.specs.automatic_open ? 'Yes' : 'No'}</div>
                        </div>
                    </div>
                </div>

                <div class="reviews-section">
                    <h3>Customer Reviews</h3>
                    ${reviewsHTML || '<p style="color:var(--text-tertiary)">No reviews yet.</p>'}
                </div>
            </div>
        `;
    }

    /* ── COMPARISON MODAL ───────────────────────────────────────── */
    function renderCompare(data) {
        const body = $('#compare-body');

        if (!data.products || !data.products.length) {
            body.innerHTML = '<p style="color:var(--text-secondary)">Select up to 3 products to compare.</p>';
            return;
        }

        const headerCells = data.products.map(p => `
            <th>
                <div class="compare-product-header">
                    <img src="${p.image_url}" alt="${p.name}">
                    <span>${p.name}</span>
                </div>
            </th>
        `).join('');

        // Rows where one value is clearly better get it highlighted: lowest price and weight, highest rest
        const BETTER = { 'Price': 'low', 'Weight': 'low', 'Rating': 'high', 'Wind Resistance': 'high', 'Canopy Size': 'high' };
        const bestIndexes = row => {
            const dir = BETTER[row.field];
            if (!dir || row.values.length < 2) return [];
            // First number in the cell: "4.7 ⭐ (12 reviews)" → 4.7, "$29.99" → 29.99
            const nums = row.values.map(v => parseFloat((String(v).match(/\d+(?:\.\d+)?/) || [])[0]));
            if (nums.some(Number.isNaN)) return [];
            const best = dir === 'low' ? Math.min(...nums) : Math.max(...nums);
            if (nums.every(n => n === best)) return [];  // a tie across the board is no one's win
            return nums.flatMap((n, i) => (n === best ? [i] : []));
        };

        const rows = data.matrix.map(row => {
            const best = bestIndexes(row);
            return `
            <tr>
                <td class="field-label">${row.field}</td>
                ${row.values.map((v, i) => (best.includes(i)
                    ? `<td class="compare-best"><span class="best-tag">Best</span> ${v}</td>`
                    : `<td>${v}</td>`)).join('')}
            </tr>`;
        }).join('');

        body.innerHTML = `
            <table class="compare-table">
                <thead><tr><th></th>${headerCells}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <p class="compare-legend"><span class="best-tag">Best</span> lowest price and weight, highest rating, wind rating and canopy size</p>
        `;
    }

    /* ── CART DRAWER ────────────────────────────────────────────── */
    function renderCart(cart, products) {
        const body = $('#cart-body');
        const footer = $('#cart-footer');

        if (!cart.length) {
            footer.style.display = 'none';
            body.innerHTML = `
                <div class="cart-empty">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
                        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
                    </svg>
                    <p>Your cart is empty</p>
                </div>
            `;
            return;
        }

        footer.style.display = 'block';

        body.innerHTML = cart.map(item => {
            const p = products.find(pr => pr.id === item.id);
            if (!p) return '';
            return `
                <div class="cart-item">
                    <img class="cart-item-image" src="${p.image_url}" alt="${p.name}">
                    <div class="cart-item-info">
                        <div class="cart-item-name">${p.name}</div>
                        <div class="cart-item-price">$${p.price.toFixed(2)}</div>
                        <button class="cart-remove" onclick="App.removeFromCart('${p.id}')">Remove</button>
                    </div>
                    <div class="cart-qty-controls">
                        <button class="cart-qty-btn" onclick="App.updateQty('${p.id}', ${item.qty - 1})">−</button>
                        <span class="cart-qty-value">${item.qty}</span>
                        <button class="cart-qty-btn" onclick="App.updateQty('${p.id}', ${item.qty + 1})">+</button>
                    </div>
                </div>
            `;
        }).join('');

        /* Summary: the same numbers the voice agent reads out */
        const { subtotal, tax, total } = App.getCartSummary();

        $('#cart-summary').innerHTML = `
            <div class="cart-summary-row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
            <div class="cart-summary-row"><span>Tax (8%)</span><span>$${tax.toFixed(2)}</span></div>
            <div class="cart-summary-row"><span>Shipping</span><span class="free-shipping">Free</span></div>
            <div class="cart-summary-row total"><span>Total</span><span>$${total.toFixed(2)}</span></div>
        `;
    }

    /* ── CHECKOUT ───────────────────────────────────────────────── */
    function renderCheckout(cart, products) {
        const body = $('#checkout-body');
        const lines = cart.map(item => ({ item, p: products.find(pr => pr.id === item.id) })).filter(l => l.p);
        const { subtotal, tax, total } = App.getCartSummary();

        body.innerHTML = `
            <div class="checkout-items">
                ${lines.map(({ item, p }) => `
                    <div class="checkout-item">
                        <img class="checkout-thumb" src="${p.image_url}" alt="${p.name}">
                        <div>
                            <div class="checkout-item-name">${p.name}</div>
                            <div class="checkout-item-qty">Qty ${item.qty} · $${p.price.toFixed(2)} each</div>
                        </div>
                        <div class="checkout-item-total">$${(p.price * item.qty).toFixed(2)}</div>
                    </div>
                `).join('')}
            </div>
            <div class="checkout-totals">
                <div class="checkout-item-row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
                <div class="checkout-item-row"><span>Tax (8%)</span><span>$${tax.toFixed(2)}</span></div>
                <div class="checkout-item-row"><span>Shipping</span><span class="free-shipping">Free</span></div>
                <div class="checkout-item-row"><span>Total</span><span>$${total.toFixed(2)}</span></div>
            </div>
            <button class="btn-primary btn-full" onclick="App.placeOrder()">Place order · $${total.toFixed(2)}</button>
        `;
    }

    /* ── BADGES ─────────────────────────────────────────────────── */
    function updateBadge(id, count) {
        const badge = document.getElementById(id);
        if (!badge) return;
        badge.textContent = count;
        badge.classList.toggle('visible', count > 0);
    }

    /* Replays the badge's pop animation (cart changes made by voice should be visible) */
    function bumpBadge(id) {
        const badge = document.getElementById(id);
        if (!badge) return;
        badge.classList.remove('bump');
        void badge.offsetWidth;  // restart the animation
        badge.classList.add('bump');
    }

    /* ── VOICE AGENT FEEDBACK ───────────────────────────────────── */
    /* Numbers the cards the agent is about to walk through: 1, 2, 3 */
    function markPositions(ids) {
        document.querySelectorAll('.card-position').forEach(el => el.remove());
        ids.forEach((id, i) => {
            const wrap = document.querySelector(`.product-card[data-id="${id}"] .card-image-wrap`);
            if (!wrap) return;
            const tag = document.createElement('span');
            tag.className = 'card-position';
            tag.textContent = i + 1;
            wrap.appendChild(tag);
        });
    }

    /* Outlines the card the agent is talking about */
    function highlightCard(id) {
        document.querySelectorAll('.product-card.agent-focus').forEach(el => el.classList.remove('agent-focus'));
        const card = document.querySelector(`.product-card[data-id="${id}"]`);
        if (card) card.classList.add('agent-focus');
    }

    /* "Agent is doing X" chip; stays up at least MIN_CHIP_MS so fast tools are still visible */
    const MIN_CHIP_MS = 1200;
    let chipShownAt = 0;
    let chipTimer;
    function toolChip() {
        let chip = document.getElementById('tool-chip');
        if (!chip) {
            chip = document.createElement('div');
            chip.id = 'tool-chip';
            chip.className = 'tool-chip';
            chip.setAttribute('role', 'status');
            document.body.appendChild(chip);
        }
        return chip;
    }

    function showToolChip(label) {
        clearTimeout(chipTimer);
        const chip = toolChip();
        chip.innerHTML = `<span class="tool-chip-dot"></span>${label}`;
        chip.classList.add('visible');
        chipShownAt = Date.now();
    }

    function hideToolChip() {
        const wait = Math.max(0, MIN_CHIP_MS - (Date.now() - chipShownAt));
        chipTimer = setTimeout(() => toolChip().classList.remove('visible'), wait);
    }

    /* ── TOAST ──────────────────────────────────────────────────── */
    function toast(message) {
        const container = $('#toast-container');
        const el = document.createElement('div');
        el.className = 'toast';
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
            el.classList.add('removing');
            el.addEventListener('animationend', () => el.remove());
        }, 2200);
    }

    /* ── TOGGLE PANELS ──────────────────────────────────────────── */
    function openPanel(overlayId, panelId) {
        document.getElementById(overlayId).classList.add('open');
        document.getElementById(panelId).classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    function closePanel(overlayId, panelId) {
        document.getElementById(overlayId).classList.remove('open');
        document.getElementById(panelId).classList.remove('open');
        document.body.style.overflow = '';
    }

    /* ── AGENT PANEL: conversation log and "Try saying" guide ───── */
    function escapeText(t) {
        const d = document.createElement('div');
        d.textContent = t;
        return d.innerHTML;
    }

    /* Adds a finished line above the turn in progress; role is 'user', 'agent' or 'note' */
    function logLine(role, text) {
        const log = $('#agent-log');
        if (!log || !text) return;
        const line = document.createElement('p');
        line.className = `log-line log-${role}`;
        if (role === 'note') line.className = 'log-note';
        line.textContent = text;
        const hints = $('#agent-hints');
        if (hints) hints.hidden = true;  // the example phrases only fill the empty log
        log.insertBefore(line, log.querySelector('.voice-transcript'));
        log.scrollTop = log.scrollHeight;
    }

    /* steps: [{ phrase, feature }]; read-only, the user says the phrases out loud */
    function renderGuide(steps) {
        const list = $('#guide-steps');
        if (!list) return;
        list.innerHTML = steps.map((st, i) => `
            <li class="guide-step" data-step="${i}">
                <span class="guide-num" data-num="${i + 1}"></span>
                <span>
                    <span class="guide-phrase">“${escapeText(st.phrase)}”</span>
                    <span class="guide-feature">${escapeText(st.feature)}</span>
                </span>
            </li>
        `).join('');
        // Open on wide screens, where the sidebar has room; on phones it stays a tap away
        if (window.matchMedia('(min-width: 900px)').matches) $('#agent-guide').open = true;
    }

    /* ── CONFETTI ───────────────────────────────────────────────── */
    function confetti() {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const canvas = document.createElement('canvas');
        canvas.className = 'confetti-canvas';
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        const w = canvas.width = window.innerWidth;
        const h = canvas.height = window.innerHeight;
        const colors = ['#0a84ff', '#bf5af2', '#30d158', '#ff9f0a', '#ff453a', '#f5f5f7'];
        const pieces = Array.from({ length: 160 }, () => ({
            x: w / 2 + (Math.random() - 0.5) * 120,
            y: h * 0.45,
            vx: (Math.random() - 0.5) * 14,
            vy: -(6 + Math.random() * 12),
            size: 5 + Math.random() * 6,
            spin: Math.random() * Math.PI,
            color: colors[Math.floor(Math.random() * colors.length)],
        }));
        const start = performance.now();
        (function frame(now) {
            const t = now - start;
            ctx.clearRect(0, 0, w, h);
            for (const c of pieces) {
                c.vy += 0.35;            // gravity
                c.vx *= 0.99;
                c.x += c.vx;
                c.y += c.vy;
                c.spin += 0.2;
                ctx.save();
                ctx.globalAlpha = Math.max(0, 1 - t / 2600);
                ctx.translate(c.x, c.y);
                ctx.rotate(c.spin);
                ctx.fillStyle = c.color;
                ctx.fillRect(-c.size / 2, -c.size / 4, c.size, c.size / 2);
                ctx.restore();
            }
            if (t < 2600) requestAnimationFrame(frame);
            else canvas.remove();
        })(start);
    }

    /* ── PUBLIC API ─────────────────────────────────────────────── */
    return {
        renderGrid,
        renderDetail,
        renderCompare,
        renderCart,
        renderCheckout,
        updateBadge,
        bumpBadge,
        markPositions,
        highlightCard,
        showToolChip,
        hideToolChip,
        logLine,
        renderGuide,
        confetti,
        toast,
        openPanel,
        closePanel,
    };
})();
