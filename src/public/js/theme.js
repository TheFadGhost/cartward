window.cartwardTheme = (() => {
  const root = document.documentElement;
  // data-surface lives on <html> so it's readable before <body> exists.
  const surface = root.dataset.surface || 'storefront';
  const storageKey = `cw-theme:${surface}`;

  function apply(theme, { persist = true } = {}) {
    root.setAttribute('data-theme', theme);
    if (persist) {
      try { localStorage.setItem(storageKey, theme); } catch { /* private mode */ }
    }
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(theme === 'dark' || theme === 'contrast'));
    });
  }

  function saved() {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  }

  function preferred() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // First visit: follow the OS preference without locking it in.
  const stored = saved();
  apply(stored ?? preferred(), { persist: !!stored });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!saved()) apply(preferred(), { persist: false });
  });

  return {
    toggle() {
      const current = root.getAttribute('data-theme');
      apply(current === 'dark' || current === 'contrast' ? 'light' : 'dark');
    },
    set: (t) => apply(t),
  };
})();

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme-toggle]');
  if (btn) window.cartwardTheme.toggle();
});
