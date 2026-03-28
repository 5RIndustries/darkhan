const CACHE_NAME = 'darkhan-cache-v2';

// On install, skip waiting to activate immediately
self.addEventListener('install', event => {
  self.skipWaiting();
});

// On activate, clear ALL old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.map(name => caches.delete(name)))
    ).then(() => self.clients.claim())
  );
});

// Network-first strategy — always try network, fall back to cache
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/') || event.request.url.includes('/socket.io/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
