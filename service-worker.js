const CACHE = "splits-v15";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Stratégie "stale-while-revalidate" : sert la version en cache immédiatement
// (offline instantané), tout en re-téléchargeant en fond pour que le prochain
// lancement soit à jour. event.waitUntil() est le point clé qui manquait avant :
// sans lui, le navigateur peut couper le service worker juste après avoir
// répondu, avant que cache.put() ait fini d'écrire — la mise à jour en fond
// n'aboutissait alors jamais, d'où le besoin de vider le cache à la main.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // laisse passer tuiles/leaflet CDN

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      const networkFetch = fetch(event.request)
        .then((res) => {
          cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);

      event.waitUntil(networkFetch);
      return cached || networkFetch;
    })
  );
});
