// sw.js — Fantasy PSL Service Worker
// ─────────────────────────────────────────────────────────────────────────
// Handles:
//   1. Push notifications (GW deadline alerts, score updates, league changes)
//   2. Offline fallback (serves cached shell when network is unavailable)
// ─────────────────────────────────────────────────────────────────────────

const CACHE_NAME = 'fpsl-v1';
const OFFLINE_URLS = [
  '/',
  '/fantasy-psl.css',
  '/manifest.json',
  '/logo.png',
  '/icon-192.png'
];

// ── Install: cache core shell ─────────────────────────────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(OFFLINE_URLS).catch(function() {
        // Fail silently — app still works online without cache
      });
    })
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ─────────────────────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// ── Fetch: network-first, fall back to cache for navigation ───────────────
self.addEventListener('fetch', function(event) {
  // Only handle same-origin GET requests
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  // API calls — never cache
  if (event.request.url.includes('/api/')) return;

  event.respondWith(
    fetch(event.request).then(function(response) {
      // Cache successful responses for the app shell
      if (response && response.status === 200) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(function() {
      // Network failed — serve from cache
      return caches.match(event.request).then(function(cached) {
        if (cached) return cached;
        // For navigation requests, return the cached home page
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});

// ── Push: show notification ───────────────────────────────────────────────
self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}

  var title   = data.title   || 'Fantasy PSL';
  var body    = data.body    || 'Tap to open the app';
  var icon    = data.icon    || '/icon-192.png';
  var badge   = data.badge   || '/icon-96.png';
  var url     = data.url     || '/';
  var tag     = data.tag     || 'fpsl-notification';

  var options = {
    body:              body,
    icon:              icon,
    badge:             badge,
    tag:               tag,       // replaces previous notification with same tag
    renotify:          true,
    requireInteraction: false,
    data:              { url: url },
    actions: data.actions || []
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification click: open/focus the app ────────────────────────────────
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // If app is already open, focus it
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// ── Background sync (optional — for queued squad saves while offline) ─────
self.addEventListener('sync', function(event) {
  if (event.tag === 'fpsl-squad-sync') {
    event.waitUntil(
      // This fires when connectivity is restored
      // The main app handles actual save logic via IndexedDB/localStorage
      self.clients.matchAll().then(function(clients) {
        clients.forEach(function(client) {
          client.postMessage({ type: 'SYNC_READY' });
        });
      })
    );
  }
});
