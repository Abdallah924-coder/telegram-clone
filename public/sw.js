const CACHE = 'devchat-v3';
const STATIC = ['/', '/index.html', '/style.css', '/manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    // Don't cache socket.io or API calls
    if (
        e.request.url.includes('/socket.io') ||
        e.request.url.includes('/api/') ||
        e.request.url.includes('/script.js')
    ) {
        e.respondWith(fetch(e.request));
        return;
    }
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
            if (res && res.status === 200 && res.type === 'basic') {
                const clone = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, clone));
            }
            return res;
        }))
    );
});

self.addEventListener('notificationclick', e => {
    e.notification.close();
    const targetUrl = e.notification.data?.url || '/';

    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            for (const client of windowClients) {
                if ('focus' in client) {
                    client.postMessage({
                        type: 'open-chat',
                        chatType: e.notification.data?.chatType,
                        chatId: e.notification.data?.chatId
                    });
                    return client.focus();
                }
            }
            if (clients.openWindow) return clients.openWindow(targetUrl);
        })
    );
});
