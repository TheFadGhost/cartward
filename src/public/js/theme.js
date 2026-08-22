window.cartwardTheme = (() => {
  const KEY = 'cw-theme';
  const root = document.documentElement;
  const surface = document.body?.dataset?.surface || 'storefront';
  const storageKey = `${KEY}:${surface}`;

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem(storageKey, theme); } catch { /* private mode */ }
  }

  function preferred() {
    let saved = null;
    try { saved = localStorage.getItem(storageKey); } catch { /* ignore */ }
    if (saved) return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  apply(preferred());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    let saved = null;
    try { saved = localStorage.getItem(storageKey); } catch { /* ignore */ }
    if (!saved) apply(preferred());
  });

  return {
    toggle() {
      const current = root.getAttribute('data-theme');
      const next = ['dark', 'contrast'].includes(current) ? 'light' : 'dark';
      apply(next);
    },
    set: apply,
  };
})();

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme-toggle]');
  if (btn) window.cartwardTheme.toggle();
});
