const CACHE_NAME = 'capdispatch-v3';

// Solo activos locales — nunca URLs externas en addAll
// (si una sola falla, addAll aborta toda la instalación)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/styles.css',
  '/js/config.js',
  '/js/idb.js',
  '/js/cost.js',
  '/js/sync.js',
  '/js/auth.js',
  '/js/app.js'
];

// ─── INSTALL ─────────────────────────────────────────────────────────────────
// Se ejecuta una sola vez cuando el service worker se instala.
// Guarda todos los archivos estáticos en caché.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // Cachea activos locales (crítico — debe completarse)
      await cache.addAll(STATIC_ASSETS);

      // Intenta cachear el CDN externo, pero no bloquea la instalación si falla
      try {
        const req = new Request('https://cdn.tailwindcss.com', { mode: 'no-cors' });
        const res = await fetch(req);
        await cache.put(req, res);
      } catch (e) {
        console.warn('[SW] No se pudo cachear Tailwind CDN:', e);
      }
    })
  );
  // Activa inmediatamente sin esperar a que se cierren las pestañas anteriores
  self.skipWaiting();
});

// ─── ACTIVATE ────────────────────────────────────────────────────────────────
// Se ejecuta cuando el service worker toma el control.
// Limpia cachés viejas y reclama clientes dentro del mismo waitUntil.
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
      // clients.claim() dentro de waitUntil garantiza que el SW toma
      // control de todas las pestañas antes de que finalice la activación
      .then(() => self.clients.claim())
  );
});

// ─── FETCH ───────────────────────────────────────────────────────────────────
// Se ejecuta en cada petición de red que hace la app.
// Estrategia:
//   - Peticiones a Supabase → Network first, sin caché (datos siempre frescos)
//   - Todo lo demás       → Cache first (archivos estáticos de la app)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const isSupabase = url.hostname.includes('supabase.co');

  if (isSupabase) {
    // Network first: intenta la red, si falla devuelve 503
    // (la lógica offline de Supabase la maneja idb.js + sync.js)
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Cache first para archivos estáticos
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // No está en caché, intenta la red y guarda el resultado
      return fetch(event.request).then(response => {
        // Cachea respuestas válidas (incluye opaque del CDN externo)
        if (!response || (response.status !== 200 && response.type !== 'opaque')) {
          return response;
        }
        const cloned = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
        return response;
      }).catch(() => {
        // Petición de navegación sin red ni caché → sirve el index
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        // Para otros recursos (scripts, imágenes, etc.) devuelve 503
        return new Response('', { status: 503 });
      });
    })
  );
});
