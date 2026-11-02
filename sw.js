/* Service worker: what makes the map installable, and what makes it work on a
   train.

   Four caches, because the things here behave nothing like each other:

     shell   the pages and scripts. Small, changes on every deploy.
     data    the exported JSON. Large - the whole export is tens of megabytes,
             so this is filled only by what you actually open, and capped.
     tiles   Esri satellite imagery. Cross-origin and opaque, so its status
             cannot be read; capped by count and never trusted.
     cdn     Leaflet from unpkg.

   deploy.sh force-pushes the site as a fresh commit, so a cached shell can be
   wrong within minutes of being right. Navigations and scripts therefore go
   to the network first and fall back to the cache, rather than the other way
   round: being briefly offline is rare, being a deploy behind is routine. */

const VERSION = 'v3';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;
const TILES = `tiles-${VERSION}`;
const CDN = `cdn-${VERSION}`;
const MINE = new Set([SHELL, DATA, TILES, CDN]);

// Enough to open any of the three views with no network at all.
const SHELL_FILES = [
  './', 'index.html', 'map.html', 'migration.html',
  'app.js', 'studio.js', 'migration.js', 'combobox.js',
  'style.css', 'studio.css',
  'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

const MAX_TILES = 600;
const MAX_DATA = 40;
// Past this, caching costs more than it saves and risks the storage quota.
const MAX_DATA_BYTES = 12 * 1024 * 1024;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // One at a time rather than addAll: addAll is all-or-nothing, and a single
    // 404 on a file we later rename would leave the worker never installing.
    await Promise.all(SHELL_FILES.map((f) =>
      c.add(new Request(f, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !MINE.has(k)).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

// Let the page ask for the new worker immediately after a deploy.
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

async function trim(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  // Insertion order, so the oldest go first. Rough, but a tile cache does not
  // warrant tracking access times in IndexedDB.
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await c.delete(k);
}

async function networkFirst(req, name, { cap = 0 } = {}) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const len = Number(res.headers.get('content-length') || 0);
      if (!cap || len <= MAX_DATA_BYTES) {
        cache.put(req, res.clone()).then(() => cap && trim(name, cap)).catch(() => {});
      }
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return hit || (await fresh) || Response.error();
}

async function cacheFirst(req, name, cap) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Opaque responses have status 0 and cannot be inspected; cache them anyway,
  // since a tile that failed simply draws as a gap next time.
  if (res && (res.ok || res.type === 'opaque')) {
    cache.put(req, res.clone()).then(() => trim(name, cap)).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Pages: network first, so a deploy is picked up on the next load.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const pre = await e.preloadResponse;
        if (pre) return pre;
        return await fetch(req);
      } catch (err) {
        const c = await caches.open(SHELL);
        return (await c.match(req)) || (await c.match('index.html')) ||
               new Response('Offline, and this page is not cached yet.',
                            { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  if (sameOrigin && url.pathname.includes('/data/')) {
    e.respondWith(networkFirst(req, DATA, { cap: MAX_DATA }));
    return;
  }

  if (sameOrigin) {
    e.respondWith(networkFirst(req, SHELL));
    return;
  }

  // Basemap imagery and labels.
  if (/arcgisonline|basemaps|tile\.openstreetmap|cartocdn/i.test(url.hostname)) {
    e.respondWith(cacheFirst(req, TILES, MAX_TILES));
    return;
  }

  if (/unpkg\.com|cdn\.jsdelivr\.net/i.test(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req, CDN));
  }
});
