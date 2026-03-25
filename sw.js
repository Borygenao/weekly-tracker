const CACHE = 'weekly-v59';
const ASSETS = [
  '/weekly-tracker/',
  '/weekly-tracker/index.html',
  '/weekly-tracker/main-app.js',
  '/weekly-tracker/dev.html',
  '/weekly-tracker/dev-app.js',
  '/weekly-tracker/icon-192.png',
  '/weekly-tracker/icon-512.png',
  '/weekly-tracker/apple-touch-icon.png',
  '/weekly-tracker/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') return;
  if (url.pathname.includes('/api/')) return;

  const isShell =
    url.pathname === '/weekly-tracker/' ||
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('/dev.html');
  const isDevRuntime = url.pathname.endsWith('/dev-app.js');
  const isMainRuntime = url.pathname.endsWith('/main-app.js');

  if (isShell || isDevRuntime || isMainRuntime) {
    e.respondWith(
      fetch(req, { cache: 'no-store' }).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match(
        url.pathname.endsWith('/dev.html') ? '/weekly-tracker/dev.html' :
        isDevRuntime ? '/weekly-tracker/dev-app.js' :
        isMainRuntime ? '/weekly-tracker/main-app.js' :
        '/weekly-tracker/index.html'
      )))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

let notifSchedule = null;
let notifTimer = null;

self.addEventListener('message', e => {
  if (e.data?.type === 'SCHEDULE_NOTIFICATIONS') {
    notifSchedule = e.data.schedule;
    scheduleNext();
  }
  if (e.data?.type === 'CANCEL_NOTIFICATIONS') {
    if (notifTimer) clearTimeout(notifTimer);
    notifSchedule = null;
  }
  if (e.data?.type === 'TASK_DATA_RESPONSE') {
    showNotification(e.data.notifType, e.data.data);
  }
});

function scheduleNext() {
  if (!notifSchedule) return;
  if (notifTimer) clearTimeout(notifTimer);

  const now = new Date();
  const times = [];

  if (notifSchedule.morningEnabled) {
    const [mh, mm] = notifSchedule.morningTime.split(':').map(Number);
    const morning = new Date(now);
    morning.setHours(mh, mm, 0, 0);
    if (morning <= now) morning.setDate(morning.getDate() + 1);
    times.push({ time: morning, type: 'morning' });
  }

  if (notifSchedule.eveningEnabled) {
    const [eh, em] = notifSchedule.eveningTime.split(':').map(Number);
    const evening = new Date(now);
    evening.setHours(eh, em, 0, 0);
    if (evening <= now) evening.setDate(evening.getDate() + 1);
    times.push({ time: evening, type: 'evening' });
  }

  if (!times.length) return;
  times.sort((a, b) => a.time - b.time);
  const next = times[0];
  const delay = next.time - now;

  notifTimer = setTimeout(() => {
    fireNotification(next.type);
    scheduleNext();
  }, delay);
}

function fireNotification(type) {
  self.clients.matchAll().then(clients => {
    if (clients.length > 0) {
      clients[0].postMessage({ type: 'REQUEST_TASK_DATA', notifType: type });
    } else {
      showNotification(type, null);
    }
  });
}

function showNotification(type, data) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  let title, body, tag;

  if (type === 'morning') {
    const total = data?.todayCount ?? 0;
    const high = data?.highCount ?? 0;
    const overdue = data?.overdueCount ?? 0;
    title = `Good morning! ${today}`;
    if (total === 0) {
      body = 'No tasks scheduled for today. Add some!';
    } else {
      body = `${total} task${total !== 1 ? 's' : ''} today${high > 0 ? `, ${high} high priority` : ''}${overdue > 0 ? `. ⚠ ${overdue} overdue` : ''}.`;
    }
    tag = 'morning-briefing';
  } else {
    const pending = data?.pendingCount ?? 0;
    const done = data?.doneCount ?? 0;
    title = 'End of day check-in';
    if (pending === 0 && done > 0) {
      body = `All ${done} tasks done today! Great work. 🎉`;
    } else if (pending === 0) {
      body = 'No tasks pending. Ready to wrap up?';
    } else {
      body = `${pending} task${pending !== 1 ? 's' : ''} still pending. Generate your daily report?`;
    }
    tag = 'evening-nudge';
  }

  self.registration.showNotification(title, {
    body,
    icon: '/weekly-tracker/icon-192.png',
    badge: '/weekly-tracker/icon-192.png',
    tag,
    renotify: true,
    data: { url: '/weekly-tracker/' }
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const appUrl = '/weekly-tracker/';
      for (const client of clients) {
        if (client.url.includes('weekly-tracker') && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(appUrl);
    })
  );
});
