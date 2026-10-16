// Service Worker for StudyTracker Pro
const CACHE_NAME = 'studytracker-v42';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/style.css',
    '/icon.png',
    '/new_year.png',
    '/manifest.json'
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

    const url = event.request.url;
    // Never intercept Firebase / Firestore / Google APIs / Cloudflare Storage in SW
    if (url.includes('firestore.googleapis.com') ||
        url.includes('identitytoolkit.googleapis.com') ||
        url.includes('securetoken.googleapis.com') ||
        url.includes('firebasestorage.googleapis.com') ||
        url.includes('apis.google.com') ||
        url.includes('r2.cloudflarestorage.com') ||
        url.includes('.r2.dev')) {
        return;
    }

    const isNavigate = event.request.mode === 'navigate';

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            const fetchPromise = fetch(event.request)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200 && (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
                        const responseToCache = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseToCache);
                        });
                    }
                    return networkResponse;
                })
                .catch(async () => {
                    if (cachedResponse) return cachedResponse;
                    if (isNavigate) {
                        const indexResp = (await caches.match('/index.html')) || (await caches.match('/'));
                        if (indexResp) return indexResp;
                    }
                    return new Response('Network unavailable', { status: 503, statusText: 'Service Unavailable' });
                });

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
