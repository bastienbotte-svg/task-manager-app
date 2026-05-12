importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-messaging-compat.js');

// Must match FIREBASE_CONFIG in index.html
firebase.initializeApp({
  apiKey:            'AIzaSyCYj9EkmFVpz5Myc2rl1m3lWFhc9Ag4XOQ',
  projectId:         'task-manager-e67a5',
  messagingSenderId: '40060854516',
  appId:             '1:40060854516:web:095fc81b0edc400945fea1'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  const title = (payload.notification && payload.notification.title) || 'Task Manager';
  const body  = (payload.notification && payload.notification.body)  || '';
  self.registration.showNotification(title, {
    body: body,
    icon: '/task-manager-app/icon-192.png',
    data: { url: '/task-manager-app/?tab=chat' }
  });
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/task-manager-app/?tab=chat';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf('/task-manager-app/') !== -1) {
          return list[i].focus().then(function(c) { return c.navigate(url); });
        }
      }
      return clients.openWindow(url);
    })
  );
});

const CACHE_NAME = 'tm-shell-v32';
const SHELL = ['/task-manager-app/', '/task-manager-app/style.css', '/task-manager-app/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
