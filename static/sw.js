/* My NAB service worker: offline app shell + last-seen API data.
 * Everything is network-first, so online use always sees fresh data and the
 * "edit a file, refresh" dev workflow still works; the cache is only the
 * fallback when the server can't be reached. Writes are NOT handled here —
 * the page's outbox (offline.js) queues those. */
"use strict";

const VERSION = "v9";
const SHELL_CACHE = "nab-shell-" + VERSION;
const API_CACHE = "nab-api-" + VERSION;
const SHELL = [
  "/", "/css/styles.css", "/manifest.json", "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png",
  "/js/offline.js", "/js/reports.js", "/js/importview.js",
  "/js/settings.js", "/js/scheduled.js", "/js/search.js", "/js/mobile.js", "/js/app.js",
];
// A server that's reachable-but-hung (bad mobile signal) shouldn't stall the
// UI forever when we already have a cached copy to show.
const API_TIMEOUT_MS = 5000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE)
    .then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, {cache: "reload"})).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((k) => k.includes("nab-") && k !== SHELL_CACHE && k !== API_CACHE)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Cached API data belongs to whichever budget was open. Drop it whenever the
// open budget could change (or its data be replaced wholesale), so budget B
// can never be shown budget A's numbers while offline — and so closing a
// budget on a shared device doesn't leave its data behind.
const CACHE_RESET = /^\/api\/(close-budget|reset-budget|backup\/restore|budgets\/\d+\/(open|setup))$/;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((r) => { clearTimeout(t); resolve(r); }, (err) => { clearTimeout(t); reject(err); });
  });
}

// Tells the page this answer came from the offline cache, not the server.
function markStale(res) {
  const headers = new Headers(res.headers);
  headers.set("X-From-Cache", "1");
  return new Response(res.body, {status: res.status, statusText: res.statusText, headers});
}

async function networkFirst(req, cacheName, {timeout = 0, fallbackKey = null, mark = false} = {}) {
  const cache = await caches.open(cacheName);
  const key = fallbackKey || req;
  const fetched = fetch(req).then((res) => {
    // A reverse proxy answers 502/503/504 when the app behind it is down —
    // that's "server unreachable", not a real answer worth showing.
    if (res.status >= 502 && res.status <= 504) throw new Error("upstream down");
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  try {
    return await (timeout ? withTimeout(fetched, timeout) : fetched);
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) {
      fetched.catch(() => {});   // let a slow request finish and refresh the cache
      return mark ? markStale(hit) : hit;
    }
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.method !== "GET") {
    if (CACHE_RESET.test(url.pathname)) {
      e.respondWith(fetch(req).then(async (res) => {
        if (res.ok) await caches.delete(API_CACHE);
        return res;
      }));
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    // Backups are big downloads, not data the UI reads back.
    if (url.pathname === "/api/backup/export") return;
    e.respondWith(networkFirst(req, API_CACHE, {timeout: API_TIMEOUT_MS, mark: true}));
    return;
  }

  // The app is a single page: any navigation falls back to the cached shell.
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, SHELL_CACHE, {fallbackKey: "/"}));
    return;
  }
  e.respondWith(networkFirst(req, SHELL_CACHE));
});
