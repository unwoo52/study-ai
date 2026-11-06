// 인터넷이 약하거나 끊겨도 앱 화면은 열리게 한다. 항상 최신 파일을 먼저 시도하고, 안 되면 저장본을 쓴다.
const CACHE = 'study-ai-v1';
const NETWORK_TIMEOUT_MS = 4000;
const FILES = [
  './',
  'index.html',
  'app.js',
  'api.js',
  'prompt.js',
  'store.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
    ]);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) ?? (await cache.match('./')) ?? Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
