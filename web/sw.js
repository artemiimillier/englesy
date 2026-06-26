// web/sw.js — ENGLESY service worker.
//
// Strategy:
//   • App shell (index.html, styles.css, js/*.js, manifest, icons): cache-first.
//     Precached on install so the app boots offline.
//   • /data/* (sentences.json, progress.json, tts-cache mp3s): network-first,
//     falling back to cache — so audio you've heard once works offline, while
//     a live network always wins to pick up data updates.
//   • /config.json: network-first (small, may change), cached as fallback.
//   • Everything else (e.g. MediaPipe CDN, fonts): pass through, opportunistic cache.
//
// Resilience first: every cache op is wrapped; a failed fetch/cache never throws
// out of an event handler. Only GET requests are handled; the rest pass through.

'use strict';

const VERSION = 'englesy-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// App-shell assets to precache. Paths are app-root-relative (served by serve.js).
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/js/main.js',
  '/js/config.js',
  '/js/data.js',
  '/js/store.js',
  '/js/engine.js',
  '/js/audio.js',
  '/js/camera.js',
  '/js/gestures.js',
  '/js/speech.js',
  '/js/trainer.js',
  '/js/ui.js',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg',
];

// ---- install: precache the shell (best-effort per asset) --------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        // Add individually so one missing/optional asset can't fail the whole install.
        await Promise.all(
          SHELL_ASSETS.map((url) =>
            cache.add(new Request(url, { cache: 'reload' })).catch(() => { /* optional asset */ })
          )
        );
      } catch (_) { /* install must not reject */ }
      try { await self.skipWaiting(); } catch (_) { /* ignore */ }
    })()
  );
});

// ---- activate: drop stale caches, take control ------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keep = new Set([SHELL_CACHE, DATA_CACHE, RUNTIME_CACHE]);
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => (keep.has(k) ? null : caches.delete(k))));
      } catch (_) { /* ignore */ }
      try { await self.clients.claim(); } catch (_) { /* ignore */ }
    })()
  );
});

// ---- helpers ----------------------------------------------------------------
async function putSafe(cacheName, request, response) {
  try {
    if (!response) return;
    // Cache opaque (cross-origin no-cors) and same-origin 200s; skip partials/errors.
    if (response.status && response.status !== 200 && response.type !== 'opaque') return;
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  } catch (_) { /* cache write failures are non-fatal */ }
}

async function cacheFirst(request, cacheName) {
  try {
    const cached = await caches.match(request);
    if (cached) return cached;
  } catch (_) { /* fall through to network */ }
  const resp = await fetch(request);
  putSafe(cacheName, request, resp.clone());
  return resp;
}

async function networkFirst(request, cacheName) {
  try {
    const resp = await fetch(request);
    putSafe(cacheName, request, resp.clone());
    return resp;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error('offline and uncached');
  }
}

// ---- fetch: route by URL ----------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // let non-GET pass straight through

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  const sameOrigin = url.origin === self.location.origin;

  // Navigations → shell index.html (network-first so updates land, offline → cached app).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const resp = await fetch(req);
          putSafe(SHELL_CACHE, req, resp.clone());
          return resp;
        } catch (_) {
          const cached = (await caches.match(req)) || (await caches.match('/index.html')) || (await caches.match('/'));
          if (cached) return cached;
          return new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        }
      })()
    );
    return;
  }

  // ENGLESY data (sentences/progress/audio) → network-first, cache fallback.
  if (sameOrigin && (url.pathname === '/data' || url.pathname.startsWith('/data/'))) {
    event.respondWith(
      networkFirst(req, DATA_CACHE).catch(
        () => new Response('', { status: 504, statusText: 'data unavailable offline' })
      )
    );
    return;
  }

  // Config → network-first (it's tiny and may change), cache fallback.
  if (sameOrigin && url.pathname === '/config.json') {
    event.respondWith(
      networkFirst(req, DATA_CACHE).catch(
        () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // Same-origin app shell / assets → network-first (fresh code lands on reload when
  // online; falls back to cache offline). Cache-first here would serve stale JS/CSS
  // after an update — bad for an app under active development.
  if (sameOrigin) {
    event.respondWith(
      networkFirst(req, SHELL_CACHE).catch(
        () => new Response('', { status: 504, statusText: 'asset unavailable offline' })
      )
    );
    return;
  }

  // Cross-origin (MediaPipe CDN, fonts, etc.) → cache-first, opportunistic, never block.
  event.respondWith(
    cacheFirst(req, RUNTIME_CACHE).catch(() => fetch(req).catch(
      () => new Response('', { status: 504, statusText: 'unavailable offline' })
    ))
  );
});

// Allow the page to trigger an immediate update.
self.addEventListener('message', (event) => {
  try {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  } catch (_) { /* ignore */ }
});
