// App shell cache-first; data (JSON) network-first so it is fresh online and still opens offline.
const C = 'coil-v22', SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url); if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/yf')) return;
  const net = () => fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; });
  e.respondWith(u.pathname.endsWith('.json') || u.pathname.endsWith('/') || u.pathname.endsWith('.html') ? net().catch(() => caches.match(e.request)) : caches.match(e.request).then(r => r || net()));
});
