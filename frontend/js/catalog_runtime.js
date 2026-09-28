/* Shared catalog formatting and filtering. Manifest values are data, never executable code. */
const CatalogRuntime = (() => {
    const money = (amount, currency = 'USD') => new Intl.NumberFormat('en-US', {
        style: 'currency', currency, maximumFractionDigits: 2, minimumFractionDigits: 2,
    }).format(amount);
    const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
    const attribute = (product, key) => (product.attributes || {})[key];
    const searchText = (product, manifest) => (manifest.search_fields || [])
        .map(key => key in (product.attributes || {}) ? attribute(product, key) : product[key])
        .filter(value => value !== undefined && value !== null)
        .join(' ').toLowerCase();
    // filter helpers

    const matches = (product, manifest, filters) => {
        if (filters.brand && filters.brand !== 'all' && product.brand !== filters.brand) return false;
        if (filters.color) {
            const wanted = String(filters.color).toLowerCase().replace(/\bgrey\b/g, 'gray').split(/[^a-z]+/).filter(Boolean);
            const colors = (String(product.color || '') + ' ' + String(product.color_family || '')).toLowerCase().replace(/\bgrey\b/g, 'gray');
            if (!wanted.every(word => colors.includes(word))) return false;
        }
        if (product.price > (filters.maxPrice ?? Infinity)) return false;
        if (filters.minRating && (product.rating === null || product.rating < filters.minRating)) return false;
        const words = String(filters.search || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.every(word => searchText(product, manifest).includes(word))) return false;
        const byParameter = new Map();
        (manifest.attributes || []).forEach(rule => (rule.filters || []).forEach(filter => byParameter.set(filter.parameter, { rule, filter })));
        for (const [parameter, requested] of Object.entries(filters.attributeFilters || {})) {
            if (requested === '' || requested === undefined || requested === null) continue;
            const entry = byParameter.get(parameter);
            if (!entry) return false;
            const value = attribute(product, entry.rule.key);
            if (value === undefined || value === null) return false;
            if (entry.filter.operator === 'min' && !(Number(value) >= Number(requested))) return false;
            if (entry.filter.operator === 'max' && !(Number(value) <= Number(requested))) return false;
            if (entry.filter.operator === 'equals') {
                if (typeof value === 'boolean') {
                    if (value !== (requested === true || requested === 'true')) return false;
                } else if (String(value).toLowerCase() !== String(requested).toLowerCase()) return false;
            }
            if (entry.filter.operator === 'contains' && !String(value).toLowerCase().includes(String(requested).toLowerCase())) return false;
        }
        return true;
    };
    const displayAttribute = (value, rule) => {
        if (value === undefined || value === null || value === '') return '';
        if (typeof value === 'boolean') return value ? 'Yes' : 'No';
        return String(value) + (rule.unit ? ' ' + rule.unit : '');
    };
    return { money, escapeHTML, attribute, searchText, matches, displayAttribute };
})();
