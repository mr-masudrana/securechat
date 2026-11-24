// শুধু অ্যাপের ফাইল ক্যাশ হয়। API (আলাদা ডোমেইন) ও মেসেজ কখনো ক্যাশ হয় না।
const CACHE = 'securechat-v1'
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
  await self.clients.claim()
})()))
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url)
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(res => {
      const c = res.clone(); caches.open(CACHE).then(x => x.put('/index.html', c)); return res
    }).catch(() => caches.match('/index.html')))
  } else if (u.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => {
      const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); return res
    })))
  }
})
