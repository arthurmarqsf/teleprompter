// Cache para funcionar offline no tablet (precache + cache em tempo de execução)
var cacheName = 'tp-v6';
var precache = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './assets/css/style.v122.css',
  './assets/css/font-awesome.min.css',
  './assets/js/plugins.v122.js',
  './assets/js/script.v122.js',
  './assets/js/camera.js',
  './assets/font/fontawesome-webfont.woff',
  './assets/img/icon-192x192.png',
  './assets/img/icon-512x512.png',
  'https://code.jquery.com/ui/1.12.1/themes/redmond/jquery-ui.min.css'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(cacheName).then(function(cache) {
      return Promise.all(precache.map(function(url) {
        return cache.add(url).catch(function() {});
      }));
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== cacheName; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') { return; }
  var url = event.request.url;
  if (url.indexOf('socket.io') !== -1) { return; }
  // Rede primeiro (pega atualizações na hora); sem internet usa o cache
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' }).then(function(response) {
      if (response && (response.ok || response.type === 'opaque')) {
        var copy = response.clone();
        caches.open(cacheName).then(function(cache) { cache.put(event.request, copy); });
      }
      return response;
    }).catch(function() {
      return caches.match(event.request, { ignoreSearch: true });
    })
  );
});
