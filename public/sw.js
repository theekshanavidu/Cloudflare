// Service Worker for StudyTracker Pro
const CACHE_NAME = 'studytracker-v15';
const ASSETS_TO_CACHE = [
    '/',
    '/icon.png',
    '/new_year.png'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        // Delete old caches
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    // Only handle GET requests
    if (event.request.method !== 'GET') return;

    // Skip Chrome extension requests or non-HTTP protocols
    if (!event.request.url.startsWith('http')) return;

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            // Stale-while-revalidate strategy: 
            // 1. Fetch from network in the background to get latest version
            const fetchPromise = fetch(event.request)
                .then((networkResponse) => {
                    // Update cache with new response
                    if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                        const responseToCache = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseToCache);
                        });
                    }
                    return networkResponse;
                })
                .catch(() => {
                    // Ignore network failure when running in offline mode
                });

            // 2. Immediately return the cached response (Instant Load) 
            // OR if not cached, wait for the network fetch
            return cachedResponse || fetchPromise;
        })
    );
});

// Handle Push Notifications
self.addEventListener('push', (event) => {
    let data = {};
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data = { body: event.data.text() };
        }
    }

    const title = data.title || 'StudyTracker Pro';
    const options = {
        body: data.body || 'You have a new message!',
        icon: '/icon.png',
        badge: '/icon.png',
        data: {
            url: data.url || '/home'
        }
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then((clientList) => {
            for (const client of clientList) {
                if (client.url === event.notification.data.url && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(event.notification.data.url);
            }
        })
    );
});
