// Pocket Vault — service worker: keeps the app itself available offline.
// It caches only the app's own files. Your documents live in IndexedDB and
// never pass through here.
//
// RELEASE RULE: change VERSION (and APP_VERSION in js/app.js) on every release.
// A new VERSION makes browsers fetch the new files; the app then shows
// "Version X is ready" and switches only when you tap Update.

const VERSION = '1.2.7';
const CACHE = `pocket-vault-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/vault.js',
  'js/search.js',
  'js/media.js',
  'js/share.js',
  'js/extract.js',
  'js/ocr.js',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/tesseract/tesseract.esm.min.js',
  'vendor/tesseract/worker.min.js',
  'vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  'vendor/tesseract/lang/eng.traineddata.gz',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // cache: 'reload' bypasses the HTTP cache so a release is fetched fresh
      cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))
    )
  );
  // No skipWaiting here: an update waits until the user taps "Update".
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('pocket-vault-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'GET_VERSION' && event.ports && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
});

// Cache first, always: the app must open instantly with no network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      return fetch(req);
    })()
  );
});
