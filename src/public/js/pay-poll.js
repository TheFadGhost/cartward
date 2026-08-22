// Polls payment status while the sandbox processor "works".
(() => {
  const params = new URLSearchParams(window.location.search);
  if (!params.get('await')) return;
  const flash = document.getElementById('await-flash');
  if (!flash) return;
  const orderId = flash.dataset.orderId;
  const token = flash.dataset.pollToken;
  let attempts = 0;

  const timer = setInterval(async () => {
    attempts += 1;
    try {
      const res = await fetch(`/orders/${orderId}/status.json?t=${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      if (data.status === 'paid' || data.paymentStatus === 'succeeded') {
        clearInterval(timer);
        window.location.reload();
      } else if (data.paymentStatus === 'failed') {
        clearInterval(timer);
        window.location.reload();
      }
    } catch {
      // transient network hiccup — keep polling
    }
    if (attempts > 20) {
      clearInterval(timer);
      if (flash) flash.textContent = 'Still waiting for the processor. This page will not update itself — reload to check.';
    }
  }, 1000);
})();
