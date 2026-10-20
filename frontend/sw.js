// TradeMind AI service worker — shows Web Push notifications (price alerts,
// sector heat, top movers, screener signals) even when the tab is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: 'TradeMind AI', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'TradeMind AI', {
    body: d.body || '',
    icon: '/assets/logo-icon-512.png',
    badge: '/assets/favicon-48.png',
    tag: d.tag || undefined,
    renotify: false,
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { c.postMessage({ type: 'open-alerts' }); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
