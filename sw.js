const CACHE = 'weekly-v76';
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
let lastTaskSnapshot = null;

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
  if (e.data?.type === 'UPDATE_TASK_SNAPSHOT') {
    lastTaskSnapshot = e.data.data || null;
  }
});

function isWeekday(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function nextWeekdayAt(timeValue, now) {
  const [hours, minutes] = String(timeValue || '08:00').split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours || 0, minutes || 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  while (!isWeekday(next)) next.setDate(next.getDate() + 1);
  return next;
}

function scheduleNext() {
  if (!notifSchedule) return;
  if (notifTimer) clearTimeout(notifTimer);

  const now = new Date();
  const times = [];

  if (notifSchedule.enabled && notifSchedule.morningEnabled) {
    times.push({ time: nextWeekdayAt(notifSchedule.morningTime, now), type: 'morning' });
  }

  if (notifSchedule.enabled && notifSchedule.eveningEnabled) {
    times.push({ time: nextWeekdayAt(notifSchedule.eveningTime, now), type: 'evening' });
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
      showNotification(type, lastTaskSnapshot);
    }
  });
}

function showNotification(type, data) {
  const current = new Date();
  if (!isWeekday(current)) return;

  const weekday = current.toLocaleDateString('en-US', { weekday: 'long' });
  let title = '';
  let body = '';
  let tag = '';

  if (type === 'morning') {
    const total = data?.todayCount ?? 0;
    const weekCount = data?.weekCount ?? 0;
    const isMonday = current.getDay() === 1;
    title = isMonday ? 'Start the week strong' : `Good morning! ${weekday}`;
    if (isMonday) {
      body = weekCount > 0
        ? `${weekCount} work task${weekCount !== 1 ? 's are' : ' is'} lined up this week. Review and plan your week.`
        : 'Plan your work week and add your first tasks.';
    } else if (total === 0) {
      body = 'No work tasks are planned for today. Add or plan today\'s work.';
    } else {
      body = `${total} work task${total !== 1 ? 's are' : ' is'} lined up for today. Review and get started.`;
    }
    tag = 'morning-briefing';
  } else {
    const pending = data?.pendingCount ?? 0;
    const done = data?.doneCount ?? 0;
    const blocked = data?.blockedCount ?? 0;
    const activity = data?.activityCount ?? (pending + done + blocked);

    if (activity <= 0 && data) return;

    title = 'End of day check-in';
    if (done > 0 && pending === 0 && blocked === 0) {
      body = `You completed ${done} work task${done !== 1 ? 's' : ''} today. Send your daily report.`;
    } else if (done > 0 || blocked > 0 || pending > 0) {
      body = `${done} done, ${blocked} blocked, ${pending} still open. Send your daily report before you wrap up.`;
    } else {
      body = 'You made progress today. Send your daily work report before you wrap up.';
    }
    tag = 'evening-nudge';
  }

  self.registration.showNotification(title, {
    body,
    icon: '/weekly-tracker/icon-192.png',
    badge: '/weekly-tracker/icon-192.png',
    tag,
    renotify: true,
    data: { url: notifSchedule?.targetUrl || '/weekly-tracker/dev.html' }
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const appUrl = e.notification?.data?.url || '/weekly-tracker/dev.html';
      for (const client of clients) {
        if (client.url.includes('weekly-tracker') && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(appUrl);
    })
  );
});
