/* Manual catalog entry. This UI is deliberately separate from the voice-agent tools. */
const Admin = (() => {
    const $ = selector => document.querySelector(selector);
    let returnFocus;

    function open() {
        App.closeAllPanels();
        returnFocus = document.activeElement;
        $('#admin-status').textContent = '';
        $('#admin-modal').setAttribute('aria-hidden', 'false');
        UI.openPanel('admin-overlay', 'admin-modal');
        $('#admin-form [name="admin_password"]').focus();
    }

    function close() {
        if (!$('#admin-modal').classList.contains('open')) return;
        UI.closePanel('admin-overlay', 'admin-modal');
        $('#admin-modal').setAttribute('aria-hidden', 'true');
        $('#admin-form [name="admin_password"]').value = '';
        (returnFocus || $('#admin-btn')).focus();
    }

    function lines(value) {
        return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    }

    async function submit(event) {
        event.preventDefault();
        const form = event.currentTarget;
        if (!form.reportValidity()) return;
        const fields = new FormData(form);
        const pros = lines(fields.get('pros'));
        const cons = lines(fields.get('cons'));
        const status = $('#admin-status');
        if (pros.length > 5 || cons.length > 5 || [...pros, ...cons].some(line => line.length > 160)) {
            status.textContent = 'Use up to five pros and five cons, each under 160 characters.';
            return;
        }

        const product = {
            name: fields.get('name').trim(),
            brand: fields.get('brand').trim(),
            model: fields.get('model').trim(),
            color: fields.get('color').trim(),
            color_family: fields.get('color_family').trim(),
            price: Number(fields.get('price')),
            image_url: fields.get('image_url').trim(),
            description: fields.get('description').trim(),
            specs: {
                frame_material: fields.get('frame_material').trim(),
                canopy_size_inches: Number(fields.get('canopy_size_inches')),
                wind_rating_mph: Number(fields.get('wind_rating_mph')),
                weight_oz: Number(fields.get('weight_oz')),
                automatic_open: fields.get('automatic_open') === 'true',
            },
            pros,
            cons,
        };
        const save = $('#admin-submit');
        save.disabled = true;
        save.textContent = 'Saving &';
        status.textContent = '';

        try {
            const response = await fetch('/api/admin/products', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Admin-Password': fields.get('admin_password'),
                },
                body: JSON.stringify(product),
            });
            const result = await response.json();
            if (!response.ok) {
                status.textContent = typeof result.detail === 'string'
                    ? result.detail
                    : 'Check the listing details and try again.';
                return;
            }
            form.reset();
            close();
            App.showNewProduct(result);
            UI.toast(`${result.name} added to the catalog`);
        } catch {
            status.textContent = 'Could not reach the store. Please try again.';
        } finally {
            save.disabled = false;
            save.textContent = 'Add to catalog';
        }
    }

    function bind() {
        $('#admin-btn').addEventListener('click', open);
        $('#admin-close').addEventListener('click', close);
        $('#admin-overlay').addEventListener('click', close);
        $('#admin-form').addEventListener('submit', submit);
        $('#admin-modal').addEventListener('keydown', event => {
            if (event.key !== 'Tab') return;
            const items = [...$('#admin-modal').querySelectorAll('button, input, select, textarea')]
                .filter(item => !item.disabled);
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });
    }

    document.addEventListener('DOMContentLoaded', bind);
    return { close };
})();
