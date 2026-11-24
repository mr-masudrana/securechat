# SecureChat

E2EE মেসেজিং ওয়েব অ্যাপ। দুটো অংশ:

- `api/` : Cloudflare Worker (D1 + Durable Objects + KV)
- `web/` : React + Vite + Tailwind ফ্রন্টএন্ড

## লোকাল চালানো

```bash
cd api && npm install && npm run db:local && npm run dev     # টার্মিনাল ১
cd web && npm install && npm run dev                         # টার্মিনাল ২
```

## GitHub দিয়ে Cloudflare-এ ডিপ্লয়

### ১. রিসোর্স তৈরি (একবার)
1. Cloudflare Dashboard → Storage & Databases → D1 → Create database, নাম `securechat-db`।
   `database_id` কপি করে `api/wrangler.jsonc`-এ `REPLACE_WITH_YOUR_D1_DATABASE_ID`-এর জায়গায় বসান।
2. D1 ডাটাবেজের Console ট্যাবে `api/schema.sql`-এর পুরো লেখা পেস্ট করে চালান।
3. KV → Create namespace, নাম `securechat-media`। ID কপি করে `api/wrangler.jsonc`-এ
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`-এর জায়গায় বসান। (কার্ড লাগে না; ফাইল ৩০ দিনে নিজে মুছে যায়।)

### ২. GitHub-এ আপলোড
```bash
git init && git add . && git commit -m "init"
git branch -M main
git remote add origin https://github.com/YOU/securechat.git
git push -u origin main
```

### ৩. API ডিপ্লয়
Workers & Pages → Create → Import a repository → রিপো বেছে নিন।
- Project name: `securechat-api` (wrangler.jsonc-এর `name`-এর সঙ্গে মিলতে হবে)
- Root directory: `api`
- Build command: খালি রাখুন
- Deploy command: `npx wrangler deploy`

ডিপ্লয় শেষে URL পাবেন, যেমন `https://securechat-api.xxxx.workers.dev`

### ৪. ওয়েব ডিপ্লয়
একই রিপো থেকে আরেকটা প্রজেক্ট:
- Project name: `securechat-web`
- Root directory: `web`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Build variables: `VITE_API_URL` = আপনার API URL (শেষে `/` নয়)

### ৫. CORS শক্ত করা
`api/wrangler.jsonc`-এ `ALLOWED_ORIGIN` এর মান ওয়েবের URL করে (যেমন `https://securechat-web.xxxx.workers.dev`) commit ও push করুন।

## ধাপ ৮: নিরাপত্তা ও PWA (এই ভার্সনে যোগ হয়েছে)
- লগইন/রেজিস্টার/আপলোডে রেট লিমিট (D1 কাউন্টার), পাসওয়ার্ড সর্বোচ্চ ২০০ অক্ষর।
- WebSocket-এ সেশন টোকেনের বদলে ৩০ সেকেন্ডের এক-বারের টিকেট।
- প্রতি কানেকশনে মেসেজ রেট লিমিট, প্রতি ইনবক্সে সর্বোচ্চ ৫০০টি অপেক্ষমাণ মেসেজ।
- প্রতিদিন (cron) মেয়াদোত্তীর্ণ সেশন/টিকেট/কাউন্টার মুছে ফেলা।
- ওয়েবে CSP ও নিরাপত্তা হেডার (`web/public/_headers`), হোম স্ক্রিনে ইনস্টলযোগ্য PWA।

**আগে ডিপ্লয় করে থাকলে:** D1 Console-এ `api/schema.sql` আবার চালান (নতুন দুটো টেবিল যোগ হবে, পুরনো ডেটা থাকবে), তারপর push করুন।

## জানা সীমাবদ্ধতা
- সেশন টোকেন `localStorage`-এ থাকে। CSP স্ক্রিপ্ট ইনজেকশন আটকায়, তবুও XSS ঝুঁকি শূন্য নয়।
- নতুন ব্রাউজারে লগইন করলে নতুন কী তৈরি হয়, পুরনো মেসেজ খুলবে না।
- লোকাল মেসেজ ব্রাউজারে আনএনক্রিপ্টেড থাকে।
- ফরওয়ার্ড সিক্রেসি নেই (Double Ratchet নেই), কী ভেরিফিকেশন ম্যানুয়াল।
