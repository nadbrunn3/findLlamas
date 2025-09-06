// Increment CACHE_NAME to bust old caches on deploys
const CACHE_NAME = 'findllamas-v4';
// Only cache static assets that rarely change. HTML files are fetched from
// the network on each navigation to avoid serving stale pages from cache.
const STATIC_ASSETS = [
  '/css/styles.css',
  '/js/index.js',
  '/js/day.js',
  '/js/photo-lightbox.js'
];

// Activate new versions immediately so clients don't keep old caches
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
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

  // cache-first for images, ignoring query params so legacy stacks don't reload
  if (/\.(?:png|jpg|jpeg|gif|webp|avif|svg)$/.test(url.pathname)) {
    const cacheKey = url.origin + url.pathname;
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(cacheKey).then(cached => {
          if (cached) return cached;
          return fetch(request).then(response => {
            cache.put(cacheKey, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // Ignore cross-origin requests not handled above
  if (url.origin !== location.origin) return;

  // Always try the network first for navigation requests so users receive the
  // latest HTML. Fall back to a cached copy if offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // network-first for other requests
  event.respondWith(
    fetch(request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
