/* Overnight Desk service worker — network-first shell, never cache API or desk data.
   v5 drops older shell caches (v4 and the cache-first desk-shell-v1 that hung iOS Home Screen). */
const CACHE = "desk-shell-v5";
const SHELL = ["index.html", "app.css?v=5", "app.css", "app.js?v=5", "app.js", "chart.js", "manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/") || url.pathname.includes("/d/")) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((cache) => cache.put(e.request, copy)).catch(() => {}));
      }
      return res;
    }).catch(() => caches.match(e.request).then((cached) => cached || Promise.reject(new Error("offline"))))
  );
});

self.addEventListener("push", (e) => {
  const data = e.data ? e.data.text() : "Overnight Desk";
  e.waitUntil(self.registration.showNotification("Grok Bot · now", { body: data, badge: "icons/icon.svg" }));
});
