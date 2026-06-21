// Minimal service worker — enables "Add to Home Screen" installability and
// offline access to the app shell. API/SSE always go straight to the network.
const CACHE = "cw-v4";
const ASSETS = [
  "/", "/index.html", "/style.css", "/app.js",
  "/manifest.webmanifest", "/icon-192.png", "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
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
  // Never intercept the live API or the SSE stream.
  if (
    ["/pair", "/command", "/events", "/status"].includes(url.pathname) ||
    url.pathname.startsWith("/hooks/")
  ) {
    return;
  }
  // Static assets: network-first (so updates land), fall back to cache offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("/index.html")))
  );
});

// ── Push notifications ──
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data ? e.data.text() : "" }; }
  const title = (data && data.title) || "Claude Watch";
  const body = (data && data.body) || "";
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      tag: (data && data.tag) || "claude-watch",
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow("/");
  })());
});
