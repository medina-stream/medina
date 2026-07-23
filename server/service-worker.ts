const serviceWorkerScript = `const CACHE_NAME = "medina-pwa-v1";
const APP_SHELL = [
  "/",
  "/manifest.json",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))));
});
`;

export function createServiceWorkerResponse() {
  return new Response(serviceWorkerScript, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/javascript; charset=utf-8",
      "service-worker-allowed": "/",
    },
  });
}

export function createServiceWorkerRegistrationScript() {
  return `<script>
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
</script>`;
}
