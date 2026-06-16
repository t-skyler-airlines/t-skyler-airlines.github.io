// T-Skyler 航空 — Service Worker（離線快取）
const CACHE = 'tskyler-v3';
const ASSETS = [
  './',
  './index.html',
  './logo.png',
  './name.png',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 跨網域資源（CDN、Wikimedia 座艙照片、QR 等）交給瀏覽器原生處理，
  // 不經 SW 快取，避免 opaque 回應造成圖片載入問題。
  if (new URL(req.url).origin !== self.location.origin) return;

  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // 頁面：network-first（線上一定拿最新版，離線才用快取）
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => { try { c.put(req, copy); } catch (_) {} });
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // 靜態資源（圖片/CDN/字型）：cache-first + 背景更新
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => { try { c.put(req, copy); } catch (_) {} });
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
