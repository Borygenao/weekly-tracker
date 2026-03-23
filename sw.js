const CACHE = 'weekly-v35';
const ASSETS = ['/weekly-tracker/', '/weekly-tracker/index.html', '/weekly-tracker/icon-192.png', '/weekly-tracker/icon-512.png', '/weekly-tracker/apple-touch-icon.png', '/weekly-tracker/manifest.json'];

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
  const url = e.request.url;
  if (!url.startsWith(self.location.origin)) return;
  if (url.includes('/api/')) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res && res.status === 200 && e.request.method === 'GET') {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// ── Notification scheduling ────────────────────────────────────
// Receives schedule from app, stores in SW scope, fires at right time
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
});

function scheduleNext() {
  if (!notifSchedule) return;
  if (notifTimer) clearTimeout(notifTimer);

  const now = new Date();
  const times = [];

  // Morning
  if (notifSchedule.morningEnabled) {
    const [mh, mm] = notifSchedule.morningTime.split(':').map(Number);
    const morning = new Date(now);
    morning.setHours(mh, mm, 0, 0);
    if (morning <= now) morning.setDate(morning.getDate() + 1);
    times.push({ time: morning, type: 'morning' });
  }

  // Evening
  if (notifSchedule.eveningEnabled) {
    const [eh, em] = notifSchedule.eveningTime.split(':').map(Number);
    const evening = new Date(now);
    evening.setHours(eh, em, 0, 0);
    if (evening <= now) evening.setDate(evening.getDate() + 1);
    times.push({ time: evening, type: 'evening' });
  }

  if (!times.length) return;

  // Sort and pick the next one
  times.sort((a, b) => a.time - b.time);
  const next = times[0];
  const delay = next.time - now;

  notifTimer = setTimeout(() => {
    fireNotification(next.type);
    scheduleNext(); // schedule the next one after firing
  }, delay);
}

function fireNotification(type) {
  // Get latest task data from app
  self.clients.matchAll().then(clients => {
    if (clients.length > 0) {
      // App is open — ask it for task data then notify
      clients[0].postMessage({ type: 'REQUEST_TASK_DATA', notifType: type });
    } else {
      // App is closed — fire generic notification
      showNotification(type, null);
    }
  });
}

// App sends back task data after REQUEST_TASK_DATA
self.addEventListener('message', e => {
  if (e.data?.type === 'TASK_DATA_RESPONSE') {
    showNotification(e.data.notifType, e.data.data);
  }
});

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

// Open app when notification is clicked
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
