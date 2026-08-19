/**
 * Prism content service worker.
 *
 * Games are plain static sites under games/<id>/<version>/. Because those paths
 * are immutable once published, the worker can serve them cache-first, which is
 * what makes "download once, play offline forever" work: the launcher asks the
 * host page to fetch every file of a version into the cache, and from then on
 * the game's own relative URLs resolve out of that cache with no network.
 */
const SHELL_CACHE = 'prism-shell-v1';
const GAME_CACHE = 'prism-games-v1';
const SHELL = ['./play.html', './host.js'];
const CATALOG = 'index.json';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== SHELL_CACHE && key !== GAME_CACHE)
            .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

const scopePath = new URL(self.registration.scope).pathname;
const isGameFile = (url) =>
  url.origin === self.location.origin && url.pathname.startsWith(scopePath + 'games/');

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (isGameFile(url)) {
    event.respondWith(cacheFirst(request, GAME_CACHE));
    return;
  }

  if (url.origin === self.location.origin && url.pathname === scopePath + CATALOG) {
    // The catalog must be current when there is a network, and must still be
    // there when there is not.
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  if (url.origin === self.location.origin && SHELL.some((p) => url.pathname.endsWith(p.slice(1)))) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;

  const response = await fetch(request);
  // Opaque or failed responses would poison the cache and later masquerade as
  // a successful download, so only real 200s are kept.
  if (response.ok && response.type === 'basic') {
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => hit);
  return hit || network;
}
