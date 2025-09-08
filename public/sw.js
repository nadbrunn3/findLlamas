// Increment CACHE_NAME to bust old caches on deploys
const CACHE_NAME = 'findllamas-v5';

// Activate new versions immediately so clients don't keep old caches
self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(keys.map(key => (key !== CACHE_NAME ? caches.delete(key) : null)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Cache-first strategy for images
  if (/\.(?:png|jpg|jpeg|gif|webp|avif|svg)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(resp => {
            cache.put(request, resp.clone());
            return resp;
          });
        })
      )
    );
    return;
  }

  // Cache stack/day JSON responses but always hit the network first
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        fetch(request)
          .then(resp => {
            cache.put(request, resp.clone());
            return resp;
          })
          .catch(() => cache.match(request))
      )
    );
    return;
  }

  // Ignore cross-origin requests not handled above
  if (url.origin !== location.origin) return;

  // Always try the network first for navigation requests so users receive the
  // latest HTML without caching it
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' }).catch(() => caches.match('/index.html'))
    );
  }
});
