// শুধু অ্যাপের ফাইল ক্যাশ হয়। API (আলাদা ডোমেইন) ও মেসেজ কখনো ক্যাশ হয় না।
const CACHE = 'securechat-v3' // নাম বদলালে পুরনো (সম্ভবত নষ্ট) ক্যাশ activate-এর সময় মুছে যায়
// শুধু সফল ও HTML-নয় এমন রেসপন্স ক্যাশ হয়: ফাইল না পেলে সার্ভার index.html (200) ফেরত দেয়, সেটা CSS/JS হিসেবে ক্যাশ হয়ে অ্যাপ স্টাইলহীন হয়ে যাওয়া ঠেকাতে
const isHtml = res => (res.headers.get('content-type') || '').includes('text/html')
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE && k !== 'prefs') await caches.delete(k)
  await self.clients.claim()
})()))
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url)
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(res => {
      if (res.ok && isHtml(res)) { const c = res.clone(); caches.open(CACHE).then(x => x.put('/index.html', c)) }
      return res
    }).catch(() => caches.match('/index.html')))
  } else if (u.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => {
      if (res.ok && !isHtml(res)) { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)) }
      return res
    })))
  }
})

// পুশ: পেলোড থাকে না (E2EE), তাই সাধারণ বার্তা। অ্যাপ সামনে খোলা থাকলে কিছু দেখায় না
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const visible = wins.some(w => w.visibilityState === 'visible')
    // iOS/Safari প্রতি পুশে নোটিফিকেশন দেখাতে বাধ্য করে, নইলে সাবস্ক্রিপশন বাতিল হতে পারে;
    // তাই অ্যাপ খোলা থাকলেও দেখিয়ে সঙ্গে সঙ্গে বন্ধ করি। অন্য ব্রাউজারে খোলা থাকলে কিছু দেখাই না।
    const ios = /iPhone|iPad|iPod/.test(self.navigator.userAgent)
    if (visible && !ios) return
    const lr = await (await caches.open('prefs')).match('/__lang')
    const en = lr && (await lr.text()) === 'en'
    await self.registration.showNotification('SecureChat', {
      body: en ? 'New message' : 'নতুন মেসেজ এসেছে', tag: 'new-message', renotify: true,
      icon: '/icon-192.png', badge: '/icon-192.png', silent: visible,
    })
    if (visible) {
      await new Promise(r => setTimeout(r, 400))
      for (const n of await self.registration.getNotifications({ tag: 'new-message' })) n.close()
    }
  })())
})
self.addEventListener('notificationclick', e => {
  e.notification.close()
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    return wins[0] ? wins[0].focus() : self.clients.openWindow('/')
  })())
})
