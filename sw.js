// Guarda la aplicación para que abra aunque no haya señal.
// Siempre intenta primero la red, así las actualizaciones se ven al instante cuando hay conexión.
const VERSION = 'inventario-v3';
const BASE = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-180.png',
  'vendor/qrcode.js', 'vendor/html5-qrcode.min.js',
  'vendor/fonts/barlow-latin-400-normal.woff2',
  'vendor/fonts/barlow-latin-500-normal.woff2',
  'vendor/fonts/barlow-latin-600-normal.woff2',
  'vendor/fonts/barlow-condensed-latin-500-normal.woff2',
  'vendor/fonts/barlow-condensed-latin-600-normal.woff2',
  'vendor/fonts/barlow-condensed-latin-700-normal.woff2'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(BASE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(r).then(function (res) {
      if (res.ok) {
        const copia = res.clone();
        caches.open(VERSION).then(function (c) { c.put(r, copia); });
      }
      return res;
    }).catch(function () {
      return caches.match(r).then(function (m) { return m || caches.match('index.html'); });
    })
  );
});
