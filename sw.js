const CACHE_NAME = 'capdispatch-v1';

// Archivos estáticos que se guardan en caché al instalar
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
  '/js/app.js',
  'https://cdn.tailwindcss.com'
];

// ─── INSTALL ─────────────────────────────────────────────────────────────────
// Se ejecuta una sola vez cuando el service worker se instala.
// Guarda todos los archivos estáticos en caché.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  // Activa inmediatamente sin esperar a que se cierren las pestañas anteriores
  self.skipWaiting();
});

// ─── ACTIVATE ────────────────────────────────────────────────────────────────
// Se ejecuta cuando el service worker toma el control.
// Limpia cachés viejas de versiones anteriores.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  // Toma control de todas las pestañas abiertas inmediatamente
  self.clients.claim();
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
    // Network first: intenta la red, si falla no hace nada
    // (la lógica offline de Supabase la maneja idb.js + sync.js)
    event.respondWith(
      fetch(event.request).catch(() => {
        // Si no hay red, devuelve una respuesta vacía con status 503
        // para que la app sepa que está offline
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
        // Solo cachea respuestas válidas
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const cloned = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
        return response;
      }).catch(() => {
        // Si es una navegación y no hay red ni caché, sirve el index
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
