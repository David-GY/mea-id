// MEA App â€” Service Worker
// Network-first for the app shell so deployments show up immediately.
// Cache is only used as an offline fallback, never as the primary source.
// NFC scanning and Google Sheets requests always go live, never cached.

const CACHE_PREFIX = 'mea-app:' + self.registration.scope + ':';
const CACHE_NAME = CACHE_PREFIX + 'mea-app-v35';
const APP_SHELL = [
  './',
  './index.html',
  './mobile-viewport.js',
  './id-tracker.html',
  './tracker-ui.css',
  './icons/ui/archive-box.svg',
  './icons/ui/folder.svg',
  './icons/ui/user.svg',
  './brand/mea-logo-lightgray.png',
  './brand/sus-logo-white.png',
  './inventory.css',
  './empty-catalog-game.css',
  './empty-catalog-game.js',
  './brand/catalog-runner.png',
  './appearance.css',
  './appearance.js',
  './dashboard.css',
  './inventory.js',
  './cart-model.js',
  './workflow.js',
  './school-auth.js',
  './signin-loading.css',
  './signin-loading.js',
  './app-config.js',
  './dashboard-rules.js',
  './dashboard-model.js',
  './dashboard.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting(); // activate the new SW immediately, don't wait for old tabs to close
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map(async (key) => {
        if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) return caches.delete(key);
        if (!/^mea-app-v\d+$/.test(key)) return;
        const cache = await caches.open(key), requests = await cache.keys();
        // Retire unscoped legacy caches only when all entries belong to this app.
        if (requests.length && requests.every(request => request.url.startsWith(self.registration.scope))) return caches.delete(key);
      }))
    )
  );
  self.clients.claim(); // take control of already-open tabs right away
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);

  // Never touch Google Apps Script requests â€” always go live, never cached
  if (url.hostname.includes('script.google.com')) {
    return;
  }

  // Only handle our own same-origin GET requests
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(scope.pathname)) {
    return;
  }
  // OAuth callback URLs and arbitrary query values must never enter the app cache.
  const privateQuery = ['code','access_token','refresh_token','token','error','error_description'].some(key => url.searchParams.has(key));
  const shellPath = new URL(url.pathname, url.origin).href;
  const isShell = APP_SHELL.some(path => new URL(path, self.registration.scope).href === shellPath);
  if (privateQuery || !isShell) return;
  const cacheKey = shellPath;

  // Network-first: always try to fetch the latest version. Only fall back
  // to the cached copy if the network request fails (e.g. offline). This is
  // what makes new deployments show up right away instead of being stuck
  // behind a stale cache.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, clone)).catch(() => {}));
        }
        return response;
      })
      .catch(async () => (await caches.open(CACHE_NAME)).match(cacheKey))
  );
});
