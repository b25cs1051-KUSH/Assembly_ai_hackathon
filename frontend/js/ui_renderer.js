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
            <article class="product-card" data-id="${p.id}">
                <div class="card-image-wrap">
                    <img src="${p.image_url}" alt="${p.name}" loading="lazy">
                    <span class="card-brand-badge">${p.brand}</span>
                    <button class="card-compare-toggle ${compareSet.has(p.id) ? 'active' : ''}"
                            data-compare-id="${p.id}" title="Compare"
                            onclick="event.stopPropagation(); App.toggleCompare('${p.id}')">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                    </button>
                </div>
                <div class="card-body" onclick="App.openDetail('${p.id}')">
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
    function renderDetail(product) {
        const body = $('#detail-body');
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
            <img class="detail-image" src="${product.image_url}" alt="${product.name}">
            <div class="detail-content">
                <div class="detail-brand">${product.brand}</div>
                <h2 class="detail-name">${product.name}</h2>
                <div class="detail-price-row">
                    <span class="detail-price">$${product.price.toFixed(2)}</span>
                    <span class="detail-rating"><span class="star-icon">★</span> ${product.rating} · ${product.review_count} reviews</span>
                </div>
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

        const rows = data.matrix.map(row => `
            <tr>
                <td class="field-label">${row.field}</td>
                ${row.values.map(v => `<td>${v}</td>`).join('')}
            </tr>
        `).join('');

        body.innerHTML = `
            <table class="compare-table">
                <thead><tr><th></th>${headerCells}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
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

        /* Summary */
        const subtotal = cart.reduce((sum, item) => {
            const p = products.find(pr => pr.id === item.id);
            return sum + (p ? p.price * item.qty : 0);
        }, 0);
        const tax = subtotal * 0.08;
        const total = subtotal + tax;

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

        const itemRows = cart.map(item => {
            const p = products.find(pr => pr.id === item.id);
            if (!p) return '';
            return `<div class="checkout-item-row"><span>${p.name} × ${item.qty}</span><span>$${(p.price * item.qty).toFixed(2)}</span></div>`;
        }).join('');

        const subtotal = cart.reduce((s, i) => {
            const p = products.find(pr => pr.id === i.id);
            return s + (p ? p.price * i.qty : 0);
        }, 0);
        const tax = subtotal * 0.08;
        const total = subtotal + tax;

        body.innerHTML = `
            <div class="checkout-grid">
                <div class="checkout-form-section">
                    <h3>Shipping Address</h3>
                    <div class="form-row">
                        <div class="form-field">
                            <label for="co-first">First Name</label>
                            <input id="co-first" type="text" placeholder="John">
                        </div>
                        <div class="form-field">
                            <label for="co-last">Last Name</label>
                            <input id="co-last" type="text" placeholder="Doe">
                        </div>
                    </div>
                    <div class="form-row full">
                        <div class="form-field">
                            <label for="co-email">Email</label>
                            <input id="co-email" type="email" placeholder="john@example.com">
                        </div>
                    </div>
                    <div class="form-row full">
                        <div class="form-field">
                            <label for="co-address">Address</label>
                            <input id="co-address" type="text" placeholder="123 Main Street">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-field">
                            <label for="co-city">City</label>
                            <input id="co-city" type="text" placeholder="San Francisco">
                        </div>
                        <div class="form-field">
                            <label for="co-zip">ZIP Code</label>
                            <input id="co-zip" type="text" placeholder="94102">
                        </div>
                    </div>
                </div>

                <div class="checkout-order-summary">
                    <h3>Order Summary</h3>
                    ${itemRows}
                    <div class="checkout-item-row" style="margin-top:0.75rem; padding-top:0.75rem; border-top:1px solid var(--border); font-weight:700; color:var(--text-primary);">
                        <span>Total (incl. tax)</span><span>$${total.toFixed(2)}</span>
                    </div>
                </div>

                <button class="btn-primary btn-full" onclick="App.placeOrder()">Place Order — $${total.toFixed(2)}</button>
            </div>
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
        toast,
        openPanel,
        closePanel,
    };
})();
