// 일정관리 서비스 워커 — 앱 설치, 앱 알림 받기, 알림을 누르면 앱 열기.
// 알림 내용은 내 PC의 봇이 이 기기의 공개키로 암호화해 보낸다(푸시 서버는 내용을 못 본다).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// 화면 열기만 거쳐 간다(저장해 두지 않음 — 일정은 늘 새로 받는다). 인터넷이 끊기면 안내 한 줄.
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<p style="font:16px sans-serif;padding:24px">인터넷에 연결되면 다시 열어 주세요.</p>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'CG 일정관리', {
    body: d.body || '', icon: 'icons/icon-192.png?v=cg1', badge: 'icons/icon-192.png?v=cg1', data: { url: './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ('focus' in w) return w.focus();      // 이미 열려 있으면 그 창으로(새 창 안 만듦)
    return self.clients.openWindow(e.notification.data.url);
  }));
});
