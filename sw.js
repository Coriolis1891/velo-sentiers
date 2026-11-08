// Service worker : l'application et les cartes téléchargées fonctionnent sans réseau.
const CACHE = 'sentiers-velo-v11';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'extras.js', 'rides.js', 'manifest.webmanifest', 'profiles/gravel.brf',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  // Ne supprime que les anciennes versions de l'application, jamais les cartes hors ligne (« tiles-… »)
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sentiers-velo-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Tuiles IGN : carte téléchargée d'abord, sinon réseau
  if (url.hostname === 'data.geopf.fr' && url.pathname === '/wmts') {
    e.respondWith(caches.match(e.request.url, { ignoreVary: true }).then((hit) => hit || fetch(e.request)));
    return;
  }
  const isShell = url.origin === location.origin || url.hostname === 'unpkg.com';
  if (!isShell) return; // API, autres tuiles : réseau direct
  // Réseau d'abord (pour recevoir les mises à jour), cache en secours
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('index.html') : undefined))));
});
