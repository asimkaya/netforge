// NetForge service worker: after the first visit the app opens without a network.
//
// - install: cache the app shell, the scripts, styles and fonts it names (Vite hashes their
//   file names, so a cached copy never goes stale).
// - fetch: /assets/* cache-first; page loads network-first with the cached shell as fallback.
//   Cross-origin requests are never touched.
// - update: a new worker waits until the page asks it to take over, so a lab that is open is
//   never reloaded by surprise (see src/ui/offline.ts).
//
// vite.config.ts replaces BUILD below with an id of the build, so every release is a new
// worker with a new cache, and activating it drops the old cache.
const BUILD = '__BUILD__';
const CACHE = `netforge-${BUILD}`;
const SHELL = ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest'];
const ICONS = ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'];

/** Same-origin /assets/ files that a page or stylesheet names (scripts, styles, woff2 fonts). */
const assetsIn = (text) =>
  [...text.matchAll(/["'(](\/assets\/[^"')\s]+\.(?:js|css|woff2))/g)].map((m) => m[1]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const page = await (await fetch('/index.html', { cache: 'reload' })).text();
      const styles = await Promise.all(
        assetsIn(page)
          .filter((url) => url.endsWith('.css'))
          .map(async (url) => (await fetch(url)).text()),
      );
      const urls = new Set([...SHELL, ...ICONS, ...assetsIn(page), ...styles.flatMap(assetsIn)]);
      await cache.addAll([...urls]);
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') event.respondWith(page(request));
  else if (url.pathname.startsWith('/assets/')) event.respondWith(asset(request));
});

/** Asset file names carry a hash of their content: a cached copy is always right. */
async function asset(request) {
  // Some hosts answer with `Vary: Origin`, which would stop a cors-mode request (module
  // scripts) from matching a copy cached without that header.
  const cached = await caches.match(request, { ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
  return response;
}

/** The app is one page: every navigation is answered with the latest copy of /index.html. */
async function page(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put('/index.html', response.clone());
    return response;
  } catch {
    const cached = await caches.match('/index.html', { ignoreVary: true });
    if (cached) return cached;
    return new Response('NetForge is offline and has not been opened online yet.', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  }
}
