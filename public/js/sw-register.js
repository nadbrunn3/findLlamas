if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache:'none' forces the browser to re-fetch sw.js on each load,
    // avoiding issues where some devices serve a cached, outdated worker.
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(err => {
      console.error('Service worker registration failed:', err);
    });
  });
}
