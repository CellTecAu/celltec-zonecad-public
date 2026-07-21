// ZoneCAD service worker — network-first, cache-fallback.
//
// Purpose: (1) satisfies installability so the app can run standalone (no URL
// bar), (2) offline fallback after a first visit. NETWORK ALWAYS WINS when
// available — the cache is only consulted when the fetch fails — so deploys are
// picked up on the next online load and stale-cache bugs can't occur.
//
// Bump CACHE on breaking changes to force old caches out (also purged on
// every activate of a new SW version).

const CACHE = 'celltec-zonecad-public-v46';

self.addEventListener('install', e => {
  // Pre-cache the shell so offline works even if the first session never
  // revisits these URLs. Everything else is cached as it's fetched.
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([
      '/celltec-zonecad-public/',
      '/celltec-zonecad-public/manifest.webmanifest',
    ]).catch(() => { /* best-effort — runtime caching covers the rest */ }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith('/celltec-zonecad-public/')) return;

  // cache: 'no-cache' = revalidate with the server (ETag/Last-Modified → 304 when
  // unchanged). Without it, fetch() reads the browser's HTTP cache, and the
  // origin's month-long max-age would pin stale ES-module imports (only the
  // entry file carries a ?v= bust) — the exact bug this line exists to prevent.
  const fresh = request.mode === 'navigate'
    ? new Request(request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(request, { cache: 'no-cache' });

  e.respondWith(
    fetch(fresh)
      .then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return resp;
      })
      .catch(() =>
        caches.match(request).then(hit =>
          // Offline navigation to any in-scope URL falls back to the app shell.
          hit ?? (request.mode === 'navigate' ? caches.match('/celltec-zonecad-public/') : undefined)
        )
      )
  );
});
