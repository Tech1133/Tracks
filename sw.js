// === ГЛАВНОЕ ПРАВИЛО: МЕНЯЙ ЭТУ ЦИФРУ ПРИ КАЖДОМ ОБНОВЛЕНИИ КОДА! ===
const APP_VERSION = 'v26'; 
const CACHE_NAME = `tracker-offline-${APP_VERSION}`;

const ASSETS = [
  '/', 
  '/index.html', 
  '/styles.css', 
  '/app.js', 
  '/db.js', 
  '/manifest.json', 
  '/favicon.svg'
];

self.addEventListener('install', event => {
  // 1. Заставляем новый Service Worker активироваться НЕМЕДЛЕННО, 
  // не дожидаясь, пока пользователь закроет все вкладки.
  self.skipWaiting();
  
  // 2. Кэшируем новые файлы
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', event => {
  // 3. При активации удаляем ВСЕ старые кэши (v7, v8 и т.д.), 
  // оставляем только текущий (v9)
  event.waitUntil(
    caches.keys().then(names => 
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  // 4. Забираем управление над всеми открытыми окнами приложения сразу
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // 5. Стратегия: Кэш сначала (для мгновенной загрузки и 100% оффлайна).
  // Но браузер ПРОВЕРИТ сам файл sw.js на наличие изменений при каждом запуске!
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      return cachedResponse || fetch(event.request).catch(() => caches.match('/index.html'));
    })
  );
});
