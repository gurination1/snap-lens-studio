const CACHE_NAME = 'snapar-studio-v3';
const ASSETS_TO_CACHE = [
  '/',
  '/static/css/studio.css?v=20261007_v3',
  '/static/js/studio.js?v=20261007_v3',
  '/static/js/jszip.min.js',
  '/static/vendor/three/three.min.js',
  '/static/vendor/three/OBJLoader.js',
  '/static/vendor/mediapipe/face_mesh.js',
  '/static/manifest.json',
  '/static/samples/nose_pin_icon.svg',
  '/static/samples/gold_tikka_icon.svg',
  '/static/samples/silver_tikka_icon.svg',
  '/static/samples/earrings_icon.svg',
  '/static/samples/ring_box_icon.svg',
  '/static/samples/bangle_icon.svg',
  '/static/samples/abyssal_crown.lns',
  '/static/samples/abyssal_crown_icon.png',
  '/static/samples/abyssal_crown.obj',
  '/static/samples/abyssal_crown_tex.png',
  '/static/samples/verdant_gilded.lns',
  '/static/samples/verdant_gilded_icon.png',
  '/static/samples/test_portrait.mp4',
  '/static/samples/test_portrait_blonde.mp4',
  '/static/samples/portrait_neutral.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Pre-caching offline assets...');
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn('[ServiceWorker] Some assets could not be cached on install:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(keyList.map((key) => {
        if (key !== CACHE_NAME) {
          console.log('[ServiceWorker] Removing old cache:', key);
          return caches.delete(key);
        }
      }));
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. API: network-first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'Offline mode active', offline: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // 2. Navigation / HTML: network-first with cache fallback
  if (event.request.mode === 'navigate' || url.pathname === '/') {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const respClone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, respClone));
        }
        return response;
      }).catch(() => caches.match('/'))
    );
    return;
  }

  // 3. Static assets: Stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return response;
      });
    })
  );
});
