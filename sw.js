/* Overnight Desk service worker — cache the shell, never cache API/state. */
const SHELL = ["index.html", "app.css", "app.js", "chart.js", "manifest.json"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open("desk-shell-v1").then((c) => c.addAll(SHELL)).catch(() => {}));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes("/api/") || url.pathname.includes("/d/")) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
self.addEventListener("push", (e) => {
  const data = e.data ? e.data.text() : "Overnight Desk";
  e.waitUntil(self.registration.showNotification("Grok Bot · now", { body: data, badge: "icons/icon.svg" }));
});
