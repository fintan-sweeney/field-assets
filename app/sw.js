// Field Assets service worker: lets the app open with no signal.
// Bump VERSION whenever you deploy changes so phones pick them up.
const VERSION = 'v63';
const SHELL = `fa-shell-${VERSION}`;
const RUNTIME = `fa-runtime-${VERSION}`;

const SHELL_FILES = [
  './', 'index.html', 'styles.css', 'work.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/fibreconx-logo.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

// Third-party libraries we're happy to cache (Supabase client, Leaflet)
const CACHEABLE_CDN = ['cdn.jsdelivr.net', 'unpkg.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App files: network first (so updates arrive), fall back to cache offline
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
    );
    return;
  }

  // CDN libraries: cache first
  if (CACHEABLE_CDN.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(RUNTIME).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
  // Everything else (Supabase API, map tiles) goes straight to the network.
});
