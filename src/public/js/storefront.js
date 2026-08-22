// Storefront behaviour. Progressive enhancement only — every flow works
// without JavaScript.

// Sort dropdown submits its form on change.
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-autosubmit]')) {
    e.target.closest('form')?.submit();
  }
});

// Product detail: keep the displayed price in sync with the selected variant.
document.querySelectorAll('.buy-form').forEach((form) => {
  const priceEl = form.closest('.buy-box')?.querySelector('.pdp-price');
  const noteEl = form.querySelector('#stock-note-live');
  const addBtn = form.querySelector('.add-to-cart');
  if (!priceEl && !noteEl) return;

  const fmt = (cents) => {
    try {
      return new Intl.NumberFormat(document.documentElement.lang || 'en-US', {
        style: 'currency', currency: 'USD',
      }).format(cents / 100);
    } catch {
      return `$${(cents / 100).toFixed(2)}`;
    }
  };

  form.addEventListener('change', (e) => {
    const input = e.target.closest('input[name="variant_id"]');
    if (!input || input.disabled) return;
    const cents = Number(input.dataset.priceCents);
    const state = input.dataset.state;
    const available = Number(input.dataset.available);
    if (priceEl && cents) priceEl.textContent = fmt(cents);
    if (noteEl) {
      if (state === 'backorder') {
        noteEl.textContent = 'Backordered — ships in 2–3 weeks.';
        noteEl.className = 'stock-note stock-backorder';
      } else if (state === 'in' && available > 0 && available <= 5) {
        noteEl.textContent = `Low stock — ${available} left`;
        noteEl.className = 'stock-note stock-low';
      } else {
        noteEl.textContent = '';
        noteEl.className = '';
      }
    }
    if (addBtn) addBtn.disabled = state === 'out';
  });
});
