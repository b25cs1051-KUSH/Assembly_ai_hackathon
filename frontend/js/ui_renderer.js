class UIRenderer {
    static renderProducts(products) {
        const grid = document.getElementById('product-grid');
        grid.innerHTML = '';
        
        products.forEach(p => {
            const card = document.createElement('div');
            card.className = 'product-card';
            card.innerHTML = `
                <img src="${p.image_url}" alt="${p.name}">
                <h3>${p.name}</h3>
                <p><strong>$${p.price}</strong> | ⭐ ${p.rating}</p>
                <p>${p.description}</p>
            `;
            grid.appendChild(card);
        });
        
        grid.style.display = 'grid';
        document.querySelector('.hero').style.display = 'none';
    }

    static updateTranscript(text) {
        const box = document.getElementById('live-transcript');
        box.innerText = text;
    }
}

window.UIRenderer = UIRenderer;
