const CACHE_VERSION = 'v5';
const CACHE_NAME    = `capdispatch-${CACHE_VERSION}`;

// Pre-cached on install for offline support.
// JS files are intentionally excluded here — they use network-first below
// so new deploys are picked up immediately without bumping CACHE_VERSION.
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/styles.css',
];

// ─── INSTALL ─────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await cache.addAll(STATIC_ASSETS);

      try {
        const req = new Request('https://cdn.tailwindcss.com', { mode: 'no-cors' });
        const res = await fetch(req);
        await cache.put(req, res);
      } catch (e) {
        console.warn('[SW] No se pudo cachear Tailwind CDN:', e);
      }
    })
  );
  self.skipWaiting();
});

// ─── ACTIVATE ────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ─── FETCH ───────────────────────────────────────────────────────────────────
// Strategies:
//   Supabase requests  → network only (no cache)
//   Own .js files      → network first, cache as offline fallback
//   Everything else    → cache first (HTML, CSS, manifest)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // Network first for own JS files — always serves the latest deploy.
  // Falls back to cache so the app still works offline.
  if (url.origin === self.location.origin && url.pathname.endsWith('.js')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request).then(r => r || new Response('', { status: 503 }))
        )
    );
    return;
  }

  // Cache first for everything else (HTML, CSS, manifest)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request)
        .then(response => {
          if (!response || (response.status !== 200 && response.type !== 'opaque')) {
            return response;
          }
          const cloned = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
          return response;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('', { status: 503 });
        });
    })
  );
});
