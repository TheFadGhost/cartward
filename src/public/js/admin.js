// Admin behaviour. Progressive enhancement only.
// Keyboard: "/" focuses the first search box, Esc closes the details/dialog.

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    const search = document.querySelector('input[type="search"], .admin-toolbar input[name="q"]');
    if (search) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  }
  if (e.key === 'Escape') {
    document.querySelectorAll('details[open].dialog').forEach((d) => d.removeAttribute('open'));
  }
});

document.addEventListener('click', (e) => {
  if (e.target.matches('[data-theme-toggle-contrast]')) {
    window.cartwardTheme.set(document.documentElement.getAttribute('data-theme') === 'contrast' ? 'light' : 'contrast');
  }
});
