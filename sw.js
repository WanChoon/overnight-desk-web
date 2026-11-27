/* Overnight Desk service worker — cache the shell, never cache API/state. */
const CACHE = "desk-shell-v3";
const SHELL = ["index.html", "app.css", "app.js", "chart.js", "manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(SHELL.map((path) =>
      fetch(new Request(path + "?v=3", { cache: "reload" }))
        .then((res) => (res && res.ok ? cache.put(path, res) : null))
        .catch(() => {})
    ))).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes("/api/") || url.pathname.includes("/d/")) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
self.addEventListener("push", (e) => {
  const data = e.data ? e.data.text() : "Overnight Desk";
  e.waitUntil(self.registration.showNotification("Grok Bot · now", { body: data, badge: "icons/icon.svg" }));
});
