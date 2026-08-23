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

// Bulk selection: live count + enable/disable action buttons.
document.querySelectorAll('[data-bulk-table]').forEach((table) => {
  const form = table.closest('form[data-bulk-form]');
  if (!form) return;
  const counter = document.getElementById('bulk-count');
  const buttons = form.querySelectorAll('button[type="submit"]');
  const checkboxes = () => [...table.querySelectorAll('[data-bulk-checkbox]')];
  const sync = () => {
    const selected = checkboxes().filter((c) => c.checked);
    if (counter) counter.textContent = ${selected.length} selected;
    buttons.forEach((b) => { b.disabled = selected.length === 0; });
  };
  table.addEventListener('change', (e) => {
    if (e.target.matches('[data-bulk-all]')) {
      checkboxes().forEach((c) => { c.checked = e.target.checked; });
    }
    sync();
  });
  sync();
});
