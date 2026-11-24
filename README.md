# SecureChat

E2EE মেসেজিং ওয়েব অ্যাপ। দুটো অংশ:

- `api/` : Cloudflare Worker (D1 + Durable Objects + R2)
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
3. R2 → Create bucket, নাম `securechat-media`।
   (ঐচ্ছিক) Settings → Object lifecycle rules-এ ৩০ দিন পর মুছে ফেলার নিয়ম দিন।

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

## জানা সীমাবদ্ধতা
- লগইনে রেট লিমিট নেই (Cloudflare ড্যাশবোর্ড থেকে WAF/Rate limiting rule দিন)।
- নতুন ব্রাউজারে লগইন করলে নতুন কী তৈরি হয়, পুরনো মেসেজ খুলবে না।
- লোকাল মেসেজ ব্রাউজারে আনএনক্রিপ্টেড থাকে।
- PWA (হোম স্ক্রিনে ইনস্টল) যোগ হয়নি।
