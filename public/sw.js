const CACHE = 'devchat-v20260501-1';
const STATIC = ['/', '/index.html', '/style.css', '/script.js', '/manifest.json'];
self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
    self.skipWaiting();
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
    self.clients.claim();
});
self.addEventListener('fetch', e => {
    if (e.request.url.includes('/socket.io') || e.request.url.includes('/api/') || e.request.url.includes('/uploads/') || e.request.url.includes('/avatars/')) {
        e.respondWith(fetch(e.request)); return;
    }
    if (e.request.mode === 'navigate') {
        e.respondWith(
            fetch(e.request)
                .then(response => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE).then(cache => cache.put('/index.html', clone));
                    }
                    return response;
                })
                .catch(() => caches.match('/index.html'))
        );
        return;
    }
    if (e.request.url.match(/\.(js|css)(\?|$)/)) {
        e.respondWith(fetch(e.request).then(r => { if(r&&r.status===200){const c=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c));}return r;}).catch(()=>caches.match(e.request))); return;
    }
    e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
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
