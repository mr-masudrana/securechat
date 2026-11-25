import { DurableObject } from 'cloudflare:workers'

export interface Env {
  DB: D1Database
  INBOX: DurableObjectNamespace
  MEDIA: KVNamespace
  ALLOWED_ORIGIN?: string
  BREVO_API_KEY?: string // Secret
  MAIL_FROM?: string // Secret: Brevo-তে ভেরিফাই করা প্রেরকের ইমেইল
  MAIL_FROM_NAME?: string
  VAPID_SUBJECT?: string // ঐচ্ছিক: mailto:you@example.com
  DEV_MODE?: string // '1' হলে মেইল না পাঠিয়ে OTP লগে ছাপে (শুধু লোকাল টেস্ট)
}

const MAX_UPLOAD = 20 * 1024 * 1024 + 1024 // ২০ MB ফাইল + IV/ট্যাগ (KV-র সীমা ২৫ MiB)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const enc = new TextEncoder()

// প্রতিটি রিকোয়েস্টের শুরুতে env থেকে সেট হয় (মান সবসময় একই)
let cors: Record<string, string> = {}
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', ...cors },
  })
const readJson = async (req: Request): Promise<any> => {
  try { return await req.json() } catch { return {} }
}

const b64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const sha256 = async (s: string) =>
  b64(await crypto.subtle.digest('SHA-256', enc.encode(s)))

async function hashPw(pw: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256)
  return b64(bits)
}

async function newSession(env: Env, userId: string) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)))
  const expires = Date.now() + 30 * 24 * 3600 * 1000
  await env.DB.prepare('INSERT INTO sessions VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, expires).run()
  return token
}

async function authToken(token: string, env: Env) {
  if (!token) return null
  return env.DB.prepare(
    `SELECT u.id, u.username, u.profile_done FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await sha256(token), Date.now()).first<{ id: string; username: string; profile_done: number }>()
}
const authUser = (req: Request, env: Env) =>
  authToken((req.headers.get('Authorization') || '').replace('Bearer ', ''), env)

// সরল রেট লিমিট (D1-এ ফিক্সড উইন্ডো কাউন্টার): সীমা পেরোলে true
async function limited(env: Env, key: string, max: number, windowSec: number) {
  const now = Date.now()
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at < ?3 THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at < ?3 THEN ?2 ELSE reset_at END
     RETURNING count`).bind(key, now + windowSec * 1000, now).first<{ count: number }>()
  return (row?.count ?? 0) > max
}
const tooMany = { error: 'অনেকবার চেষ্টা করেছেন, কিছুক্ষণ পরে আবার চেষ্টা করুন' }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const cleanEmail = (v: unknown) => String(v ?? '').trim().toLowerCase()
const validEmail = (e: string) => e.length <= 254 && EMAIL_RE.test(e)
const meOf = (u: any) => ({
  id: u.id, username: u.profile_done ? u.username : '', fullName: u.full_name || u.username,
  email: u.email ?? null, avatar: u.avatar ?? null, needsProfile: !u.profile_done,
})

// Brevo (ফ্রি, কার্ড লাগে না) দিয়ে ইমেইল পাঠানো
async function sendMail(env: Env, to: string, subject: string, text: string) {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM) {
    if (env.DEV_MODE === '1') { console.log(`[DEV MAIL] to=${to}\n${text}`); return }
    throw new Error('mail: not configured')
  }
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: env.MAIL_FROM_NAME || 'SecureChat', email: env.MAIL_FROM },
      to: [{ email: to }], subject, textContent: text,
    }),
  })
  if (!r.ok) { console.error('brevo', r.status, await r.text()); throw new Error('mail: failed') }
}

type Purpose = 'signup' | 'reset' | 'email'
async function issueOtp(env: Env, email: string, purpose: Purpose,
  extra: { full_name?: string; pass_hash?: string; salt?: string }, force: boolean) {
  const row = await env.DB.prepare('SELECT sent_at FROM otps WHERE email = ? AND purpose = ?')
    .bind(email, purpose).first<{ sent_at: number }>()
  if (!force && row && Date.now() - row.sent_at < 60_000) return 'cooldown'
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO otps (email, purpose, code_hash, expires_at, attempts, sent_at, full_name, pass_hash, salt)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8)
     ON CONFLICT(email, purpose) DO UPDATE SET code_hash = ?3, expires_at = ?4, attempts = 0, sent_at = ?5,
       full_name = COALESCE(?6, full_name), pass_hash = COALESCE(?7, pass_hash), salt = COALESCE(?8, salt)`)
    .bind(email, purpose, await sha256(code + ':' + email), now + 10 * 60_000, now,
      extra.full_name ?? null, extra.pass_hash ?? null, extra.salt ?? null).run()
  const what = purpose === 'signup' ? 'অ্যাকাউন্ট ভেরিফিকেশন' : purpose === 'reset' ? 'পাসওয়ার্ড রিসেট' : 'ইমেইল পরিবর্তন'
  await sendMail(env, email, `SecureChat ${what} কোড: ${code}`,
    `আপনার SecureChat ${what} কোড: ${code}\n\nকোডটি ১০ মিনিট পর্যন্ত বৈধ। কাউকে এই কোড দেবেন না।\nআপনি এটা না চাইলে এই ইমেইল উপেক্ষা করুন।\n\nYour SecureChat code: ${code} (valid for 10 minutes)`)
  return 'ok'
}

async function checkOtp(env: Env, email: string, purpose: Purpose, code: unknown):
  Promise<{ ok: true; row: any } | { ok: false; error: string }> {
  const row = await env.DB.prepare('SELECT * FROM otps WHERE email = ? AND purpose = ?')
    .bind(email, purpose).first<any>()
  if (!row || row.expires_at < Date.now()) return { ok: false, error: 'কোডের মেয়াদ শেষ, নতুন কোড নিন' }
  if (row.attempts >= 5) return { ok: false, error: 'অনেকবার ভুল হয়েছে, নতুন কোড নিন' }
  if ((await sha256(String(code ?? '').trim() + ':' + email)) !== row.code_hash) {
    await env.DB.prepare('UPDATE otps SET attempts = attempts + 1 WHERE email = ? AND purpose = ?')
      .bind(email, purpose).run()
    return { ok: false, error: 'কোড ঠিক নেই' }
  }
  return { ok: true, row }
}

// ---------- Web Push (পেলোড ছাড়া, VAPID); কী প্রথমবার নিজে তৈরি হয়ে D1-এ থাকে ----------
type Vapid = { pub: string; key: CryptoKey }
let vapidCache: Vapid | null = null
const b64u = (b: ArrayBuffer | Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64u = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))

async function getVapid(env: Env): Promise<Vapid> {
  if (vapidCache) return vapidCache
  const get = () => env.DB.prepare("SELECT value FROM config WHERE key = 'vapid'").first<{ value: string }>()
  let row = await get()
  if (!row) {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const j = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey
    await env.DB.prepare("INSERT OR IGNORE INTO config (key, value) VALUES ('vapid', ?)").bind(JSON.stringify(j)).run()
    row = await get()
  }
  const jwk = JSON.parse(row!.value) as JsonWebKey
  const raw = new Uint8Array(65)
  raw[0] = 4
  raw.set(unb64u(jwk.x!), 1)
  raw.set(unb64u(jwk.y!), 33)
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return (vapidCache = { pub: b64u(raw), key })
}

// শুধু পরিচিত পুশ সার্ভিসে পাঠানো হয়, যাতে ইউজারের দেওয়া URL দিয়ে অন্য কোথাও রিকোয়েস্ট না যায়
const pushHostOk = (u: URL) => u.protocol === 'https:' && (
  u.hostname === 'fcm.googleapis.com' || u.hostname === 'updates.push.services.mozilla.com' ||
  u.hostname.endsWith('.push.apple.com') || u.hostname.endsWith('.notify.windows.com'))

async function sendPush(v: Vapid, endpoint: string, env: Env): Promise<number> {
  try {
    const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
    const claims = b64u(enc.encode(JSON.stringify({
      aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: env.VAPID_SUBJECT || (env.MAIL_FROM ? 'mailto:' + env.MAIL_FROM : 'mailto:admin@example.com'),
    })))
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, enc.encode(head + '.' + claims))
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.pub}`, TTL: '86400', Urgency: 'high' },
    })
    return r.status
  } catch {
    return 0
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    }
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
    const { pathname } = new URL(req.url)
    const ip = req.headers.get('CF-Connecting-IP') || 'local'

    try {
      if (pathname === '/api/register' && req.method === 'POST') {
        const b = await readJson(req)
        const email = cleanEmail(b.email)
        const fullName = String(b.fullName ?? '').trim().replace(/\s+/g, ' ')
        const password = b.password
        if (fullName.length < 2 || fullName.length > 60) return json({ error: 'পুরো নাম ২-৬০ অক্ষরের হতে হবে' }, 400)
        if (!validEmail(email)) return json({ error: 'ইমেইল ঠিক নেই' }, 400)
        if (typeof password !== 'string' || password.length < 8 || password.length > 200)
          return json({ error: 'Password ৮ থেকে ২০০ অক্ষরের হতে হবে' }, 400)
        if (await limited(env, `reg:${ip}`, 10, 3600) || await limited(env, `otp:${email}`, 5, 3600))
          return json(tooMany, 429)
        if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first())
          return json({ error: 'এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট আছে, লগইন করুন' }, 409)
        const salt = crypto.getRandomValues(new Uint8Array(16))
        await issueOtp(env, email, 'signup',
          { full_name: fullName, pass_hash: await hashPw(password, salt), salt: b64(salt) }, true)
        return json({ ok: true })
      }

      if (pathname === '/api/resend' && req.method === 'POST') {
        const b = await readJson(req)
        const email = cleanEmail(b.email)
        const purpose: Purpose = b.purpose === 'reset' ? 'reset' : 'signup'
        if (!validEmail(email)) return json({ error: 'ইমেইল ঠিক নেই' }, 400)
        if (await limited(env, `otp:${email}`, 5, 3600)) return json(tooMany, 429)
        if (purpose === 'signup') {
          if (!(await env.DB.prepare("SELECT 1 FROM otps WHERE email = ? AND purpose = 'signup'").bind(email).first()))
            return json({ error: 'আবার রেজিস্টার করুন' }, 400)
        } else if (!(await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first())) {
          return json({ ok: true }) // অ্যাকাউন্ট আছে কিনা জানানো হয় না
        }
        const r = await issueOtp(env, email, purpose, {}, false)
        return r === 'cooldown' ? json({ error: 'এক মিনিট পরে আবার চেষ্টা করুন' }, 429) : json({ ok: true })
      }

      if (pathname === '/api/verify' && req.method === 'POST') {
        const b = await readJson(req)
        const email = cleanEmail(b.email)
        if (await limited(env, `verify:${ip}`, 30, 900)) return json(tooMany, 429)
        const c = await checkOtp(env, email, 'signup', b.code)
        if (!c.ok) return json({ error: c.error }, 400)
        const id = crypto.randomUUID()
        try {
          await env.DB.prepare(
            `INSERT INTO users (id, username, pass_hash, salt, created_at, email, full_name, profile_done)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
            .bind(id, 'p_' + id.replace(/-/g, ''), c.row.pass_hash, c.row.salt, Date.now(), email, c.row.full_name).run()
        } catch {
          return json({ error: 'এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট আছে' }, 409)
        }
        await env.DB.prepare("DELETE FROM otps WHERE email = ? AND purpose = 'signup'").bind(email).run()
        const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<any>()
        return json({ token: await newSession(env, id), me: meOf(u) })
      }

      if (pathname === '/api/login' && req.method === 'POST') {
        const b = await readJson(req)
        const ident = String(b.identifier ?? b.username ?? '').trim()
        const password = String(b.password ?? '')
        if (await limited(env, `login-ip:${ip}`, 30, 300) ||
            await limited(env, `login-user:${ident.toLowerCase()}`, 10, 900))
          return json(tooMany, 429)
        const byEmail = ident.includes('@')
        const u = await env.DB.prepare(byEmail
          ? 'SELECT * FROM users WHERE email = ?'
          : 'SELECT * FROM users WHERE username = ? AND profile_done = 1')
          .bind(byEmail ? ident.toLowerCase() : ident).first<any>()
        const ok = u && (await hashPw(password, unb64(u.salt))) === u.pass_hash
        if (!ok) return json({ error: 'ইমেইল/username বা password ভুল' }, 401)
        return json({ token: await newSession(env, u.id), me: meOf(u) })
      }

      if (pathname === '/api/forgot' && req.method === 'POST') {
        const email = cleanEmail((await readJson(req)).email)
        if (!validEmail(email)) return json({ error: 'ইমেইল ঠিক নেই' }, 400)
        if (await limited(env, `otp:${email}`, 5, 3600) || await limited(env, `forgot:${ip}`, 10, 3600))
          return json(tooMany, 429)
        if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first())
          await issueOtp(env, email, 'reset', {}, true)
        return json({ ok: true }) // অ্যাকাউন্ট আছে কিনা জানানো হয় না
      }

      if (pathname === '/api/reset' && req.method === 'POST') {
        const b = await readJson(req)
        const email = cleanEmail(b.email)
        if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200)
          return json({ error: 'Password ৮ থেকে ২০০ অক্ষরের হতে হবে' }, 400)
        if (await limited(env, `verify:${ip}`, 30, 900)) return json(tooMany, 429)
        const c = await checkOtp(env, email, 'reset', b.code)
        if (!c.ok) return json({ error: c.error }, 400)
        const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>()
        if (!u) return json({ error: 'কোডের মেয়াদ শেষ, নতুন কোড নিন' }, 400)
        const salt = crypto.getRandomValues(new Uint8Array(16))
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?')
            .bind(await hashPw(b.password, salt), b64(salt), u.id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id), // সব ডিভাইস থেকে লগআউট
          env.DB.prepare('DELETE FROM push_subs WHERE user_id = ?').bind(u.id),
          env.DB.prepare("DELETE FROM otps WHERE email = ? AND purpose = 'reset'").bind(email),
        ])
        return json({ ok: true })
      }

      if (pathname === '/api/logout' && req.method === 'POST') {
        const token = (req.headers.get('Authorization') || '').replace('Bearer ', '')
        if (token)
          await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run()
        return json({ ok: true })
      }

      // WebSocket-এর জন্য ৩০ সেকেন্ডের এক-বারের টিকেট, যাতে সেশন টোকেন URL-এ না যায়
      if (pathname === '/api/ws-ticket' && req.method === 'POST') {
        const user = await authUser(req, env)
        if (!user) return json({ error: 'Unauthorized' }, 401)
        if (!user.profile_done) return json({ error: 'আগে প্রোফাইল সম্পূর্ণ করুন' }, 403)
        const ticket = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[^a-zA-Z0-9]/g, '')
        await env.DB.prepare('INSERT INTO ws_tickets VALUES (?, ?, ?)')
          .bind(await sha256(ticket), user.id, Date.now() + 30_000).run()
        return json({ ticket })
      }

      if (pathname === '/api/ws') {
        if (req.headers.get('Upgrade') !== 'websocket')
          return json({ error: 'Expected websocket' }, 426)
        const allowed = env.ALLOWED_ORIGIN
        const origin = req.headers.get('Origin')
        if (allowed && allowed !== '*' && origin && origin !== allowed)
          return json({ error: 'Forbidden origin' }, 403)
        const ticket = new URL(req.url).searchParams.get('ticket') || ''
        const t = await env.DB.prepare(
          'DELETE FROM ws_tickets WHERE ticket_hash = ? AND expires_at > ? RETURNING user_id')
          .bind(await sha256(ticket), Date.now()).first<{ user_id: string }>()
        const user = t && await env.DB.prepare('SELECT id, username FROM users WHERE id = ?')
          .bind(t.user_id).first<{ id: string; username: string }>()
        if (!user) return json({ error: 'Unauthorized' }, 401)
        const headers = new Headers(req.headers)
        headers.set('X-Username', user.username)
        return env.INBOX.get(env.INBOX.idFromName(user.id)).fetch(new Request(req, { headers }))
      }

      if (pathname === '/api/me') {
        const user = await authUser(req, env)
        if (!user) return json({ error: 'Unauthorized' }, 401)
        const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first<any>()
        return json(meOf(u))
      }

      // প্রথমবার username + ছবি; পরে শুধু ছবি বদলানো যায়
      if (pathname === '/api/profile' && req.method === 'POST') {
        const user = await authUser(req, env)
        if (!user) return json({ error: 'Unauthorized' }, 401)
        const { username, avatar } = await readJson(req)
        const hasAvatar = typeof avatar === 'string'
        if (hasAvatar && (!avatar.startsWith('data:image/jpeg;base64,') || avatar.length > 80_000))
          return json({ error: 'ছবি ঠিক নেই' }, 400)
        if (!user.profile_done) {
          if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || ''))
            return json({ error: 'Username ৩-২০ অক্ষর, শুধু ইংরেজি অক্ষর/সংখ্যা/_' }, 400)
          const hold = await env.DB.prepare('SELECT user_id FROM username_holds WHERE username = ? AND until > ?')
            .bind(username, Date.now()).first<{ user_id: string }>()
          if (hold && hold.user_id !== user.id) return json({ error: 'এই username কিছুদিনের জন্য সংরক্ষিত, অন্য একটা বেছে নিন' }, 409)
          try {
            await env.DB.prepare('UPDATE users SET username = ?, avatar = COALESCE(?, avatar), profile_done = 1 WHERE id = ?')
              .bind(username, hasAvatar ? avatar : null, user.id).run()
          } catch {
            return json({ error: 'এই username নেওয়া হয়ে গেছে' }, 409)
          }
        } else if (hasAvatar) {
          await env.DB.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(avatar, user.id).run()
        }
        const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first<any>()
        return json(meOf(u))
      }

      if (pathname === '/api/key' && req.method === 'PUT') {
        const user = await authUser(req, env)
        if (!user) return json({ error: 'Unauthorized' }, 401)
        const { publicKey } = await readJson(req)
        if (typeof publicKey !== 'string' || publicKey.length !== 88)
          return json({ error: 'Invalid key' }, 400)
        await env.DB.prepare('UPDATE users SET public_key = ? WHERE id = ?')
          .bind(publicKey, user.id).run()
        return json({ ok: true })
      }

      if (pathname.startsWith('/api/users/') && req.method === 'GET') {
        if (!(await authUser(req, env))) return json({ error: 'Unauthorized' }, 401)
        const name = decodeURIComponent(pathname.slice('/api/users/'.length))
        const u = await env.DB.prepare(
          'SELECT username, full_name, avatar, public_key FROM users WHERE username = ? AND profile_done = 1')
          .bind(name).first<any>()
        return u
          ? json({ username: u.username, fullName: u.full_name || u.username, avatar: u.avatar, publicKey: u.public_key })
          : json({ error: 'Not found' }, 404)
      }

      // ---- অ্যাকাউন্ট বদল: নাম, পাসওয়ার্ড, ইমেইল (কোড দিয়ে), username ----
      if (pathname.startsWith('/api/account/') && req.method === 'POST') {
        const user = await authUser(req, env)
        if (!user || !user.profile_done) return json({ error: 'Unauthorized' }, 401)
        if (await limited(env, `acct:${user.id}`, 40, 3600)) return json(tooMany, 429)
        const what = pathname.slice('/api/account/'.length)
        const b = await readJson(req)
        const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first<any>()
        const needPw = async (): Promise<Response | null> => {
          if (await limited(env, `pwtry:${user.id}`, 10, 900)) return json(tooMany, 429)
          return (await hashPw(String(b.current ?? ''), unb64(row.salt))) === row.pass_hash
            ? null : json({ error: 'বর্তমান পাসওয়ার্ড ভুল' }, 403)
        }

        if (what === 'name') {
          const fullName = String(b.fullName ?? '').trim().replace(/\s+/g, ' ')
          if (fullName.length < 2 || fullName.length > 60) return json({ error: 'পুরো নাম ২-৬০ অক্ষরের হতে হবে' }, 400)
          await env.DB.prepare('UPDATE users SET full_name = ? WHERE id = ?').bind(fullName, user.id).run()
          return json({ ok: true, fullName })
        }

        if (what === 'password') {
          const bad = await needPw()
          if (bad) return bad
          if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200)
            return json({ error: 'নতুন Password ৮ থেকে ২০০ অক্ষরের হতে হবে' }, 400)
          const salt = crypto.getRandomValues(new Uint8Array(16))
          const mine = await sha256((req.headers.get('Authorization') || '').replace('Bearer ', ''))
          await env.DB.batch([
            env.DB.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?')
              .bind(await hashPw(b.password, salt), b64(salt), user.id),
            env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, mine), // অন্য ডিভাইস লগআউট
          ])
          return json({ ok: true })
        }

        if (what === 'email') {
          const bad = await needPw()
          if (bad) return bad
          const email = cleanEmail(b.email)
          if (!validEmail(email)) return json({ error: 'ইমেইল ঠিক নেই' }, 400)
          if (await limited(env, `otp:${email}`, 5, 3600)) return json(tooMany, 429)
          if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').bind(email, user.id).first())
            return json({ error: 'এই ইমেইল অন্য অ্যাকাউন্টে ব্যবহার হচ্ছে' }, 409)
          await issueOtp(env, email, 'email', { full_name: user.id }, true) // full_name কলামে ইউজার id রাখা হয়
          return json({ ok: true })
        }

        if (what === 'email/verify') {
          const email = cleanEmail(b.email)
          const c = await checkOtp(env, email, 'email', b.code)
          if (!c.ok) return json({ error: c.error }, 400)
          if (c.row.full_name !== user.id) return json({ error: 'কোডের মেয়াদ শেষ, নতুন কোড নিন' }, 400)
          try {
            await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, user.id).run()
          } catch {
            return json({ error: 'এই ইমেইল অন্য অ্যাকাউন্টে ব্যবহার হচ্ছে' }, 409)
          }
          await env.DB.prepare("DELETE FROM otps WHERE email = ? AND purpose = 'email'").bind(email).run()
          if (row.email && row.email !== email) { // পুরনো ঠিকানায় সতর্কবার্তা
            try {
              await sendMail(env, row.email, 'SecureChat: আপনার ইমেইল বদলানো হয়েছে',
                `আপনার SecureChat অ্যাকাউন্টের ইমেইল ${email} করা হয়েছে।\nএটা আপনি না করলে এখনই পাসওয়ার্ড রিসেট করুন।`)
            } catch { /* সতর্কবার্তা না গেলেও বদল বৈধ */ }
          }
          return json({ ok: true, email })
        }

        if (what === 'username') {
          const bad = await needPw()
          if (bad) return bad
          const name = String(b.username ?? '').trim()
          if (!/^[a-zA-Z0-9_]{3,20}$/.test(name))
            return json({ error: 'Username ৩-২০ অক্ষর, শুধু ইংরেজি অক্ষর/সংখ্যা/_' }, 400)
          if (name === row.username) return json({ error: 'এটাই আপনার বর্তমান username' }, 400)
          const sameLetters = name.toLowerCase() === row.username.toLowerCase() // শুধু বড়-ছোট হাতের বদল
          if (!sameLetters) {
            // ব্যর্থ চেষ্টা কোটা খায় না: সফল বদলের সময় তারিখ রাখা হয়
            const last = await env.DB.prepare('SELECT value FROM config WHERE key = ?')
              .bind('uname:' + user.id).first<{ value: string }>()
            const wait = last ? Number(last.value) + 30 * 86400_000 - Date.now() : 0
            if (wait > 0)
              return json({ error: `Username মাসে একবার বদলানো যায়। আবার বদলাতে পারবেন ${Math.ceil(wait / 86400_000)} দিন পর` }, 429)
            const hold = await env.DB.prepare('SELECT user_id FROM username_holds WHERE username = ? AND until > ?')
              .bind(name, Date.now()).first<{ user_id: string }>()
            if (hold && hold.user_id !== user.id)
              return json({ error: 'এই username কিছুদিনের জন্য সংরক্ষিত, অন্য একটা বেছে নিন' }, 409)
          }
          try {
            await env.DB.batch([
              env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(name, user.id),
              // পুরনো username ৩০ দিন অন্য কেউ নিতে পারবে না (কন্টাক্টদের চ্যাটে ভুয়া ব্যক্তি ঢোকা ঠেকাতে)
              ...(sameLetters ? [] : [env.DB.prepare('INSERT OR REPLACE INTO username_holds (username, user_id, until) VALUES (?, ?, ?)')
                .bind(row.username, user.id, Date.now() + 30 * 86400_000),
                env.DB.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').bind('uname:' + user.id, String(Date.now()))]),
              env.DB.prepare('DELETE FROM username_holds WHERE username = ? AND user_id = ?').bind(name, user.id),
            ])
          } catch {
            return json({ error: 'এই username নেওয়া হয়ে গেছে' }, 409)
          }
          return json({ ok: true, username: name })
        }

        return json({ error: 'Not found' }, 404)
      }

      if (pathname === '/api/push/key') return json({ key: (await getVapid(env)).pub })

      if (pathname === '/api/push/subscribe' && req.method === 'POST') {
        const user = await authUser(req, env)
        if (!user || !user.profile_done) return json({ error: 'Unauthorized' }, 401)
        if (await limited(env, `push:${user.id}`, 30, 3600)) return json(tooMany, 429)
        const { endpoint } = await readJson(req)
        let u: URL
        try { u = new URL(String(endpoint)) } catch { return json({ error: 'Invalid endpoint' }, 400) }
        if (String(endpoint).length > 600 || !pushHostOk(u)) return json({ error: 'Invalid endpoint' }, 400)
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO push_subs (endpoint, user_id, created_at) VALUES (?1, ?2, ?3)
                          ON CONFLICT(endpoint) DO UPDATE SET user_id = ?2`).bind(endpoint, user.id, Date.now()),
          env.DB.prepare(`DELETE FROM push_subs WHERE user_id = ?1 AND endpoint NOT IN
                          (SELECT endpoint FROM push_subs WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 5)`).bind(user.id),
        ])
        return json({ ok: true })
      }

      if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
        const user = await authUser(req, env)
        if (!user) return json({ error: 'Unauthorized' }, 401)
        const { endpoint } = await readJson(req)
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?')
          .bind(String(endpoint), user.id).run()
        return json({ ok: true })
      }

      if (pathname === '/api/media' && req.method === 'POST') {
        const user = await authUser(req, env)
        if (!user) return json({ error: 'Unauthorized' }, 401)
        if (await limited(env, `media:${user.id}`, 60, 60)) return json(tooMany, 429)
        const to = new URL(req.url).searchParams.get('to') || ''
        const rcpt = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
          .bind(to).first<{ id: string }>()
        if (!rcpt) return json({ error: 'ইউজার পাওয়া যায়নি' }, 404)

        if (!env.MEDIA) return json({ error: 'ফাইল স্টোরেজ (KV) সেটআপ হয়নি: wrangler.jsonc-এ binding "MEDIA" ও namespace ID দিন' }, 503)
        // কিছু পথে Content-Length আসে না, তাই শুধু তার ওপর নির্ভর না করে বডি পড়ে মাপ দেখি
        if (Number(req.headers.get('Content-Length') || 0) > MAX_UPLOAD) return json({ error: 'ফাইল সর্বোচ্চ ২০ MB হতে পারবে' }, 413)
        const body = await req.arrayBuffer()
        if (!body.byteLength) return json({ error: 'ফাইলটা খালি' }, 400)
        if (body.byteLength > MAX_UPLOAD) return json({ error: 'ফাইল সর্বোচ্চ ২০ MB হতে পারবে' }, 413)

        const id = crypto.randomUUID()
        try {
          await env.MEDIA.put(id, body, {
            metadata: { from: user.id, to: rcpt.id },
            expirationTtl: 30 * 24 * 3600, // ৩০ দিনে নিজে মুছে যাবে
          })
        } catch (e) {
          console.error('kv put', e)
          return json({ error: 'ফাইল সংরক্ষণ করা যায়নি (KV-র দৈনিক সীমা শেষ বা সেটআপ ভুল হতে পারে)' }, 502)
        }
        return json({ id })
      }

      const mm = pathname.match(/^\/api\/media\/([0-9a-f-]{36})$/)
      if (mm && UUID.test(mm[1])) {
        const user = await authUser(req, env)
        if (!user) return json({ error: 'Unauthorized' }, 401)
        const allowedMeta = (meta?: { from?: string; to?: string } | null) => meta?.to === user.id || meta?.from === user.id

        if (req.method === 'GET') {
          const { value, metadata } = await env.MEDIA.getWithMetadata<{ from: string; to: string }>(mm[1], 'arrayBuffer')
          if (!value || !allowedMeta(metadata)) return json({ error: 'ফাইল পাওয়া যায়নি' }, 404)
          return new Response(value, {
            headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', ...cors },
          })
        }
        if (req.method === 'DELETE') {
          await env.MEDIA.delete(mm[1]) // আইডি শুধু প্রেরক ও প্রাপকের জানা (UUID)
          return json({ ok: true })
        }
      }

      return json({ error: 'Not found' }, 404)
    } catch (e) {
      console.error(e)
      const mail = e instanceof Error && e.message.startsWith('mail')
      return json({ error: mail ? 'ইমেইল পাঠানো যায়নি, একটু পরে আবার চেষ্টা করুন' : 'সার্ভারে সমস্যা হয়েছে' }, mail ? 502 : 500)
    }
  },

  // প্রতিদিন মেয়াদোত্তীর্ণ সেশন, টিকেট ও কাউন্টার মুছে ফেলে
  async scheduled(_e: ScheduledController, env: Env) {
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM ws_tickets WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(now),
      env.DB.prepare('DELETE FROM otps WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM username_holds WHERE until < ?').bind(now),
    ])
  },
}

export class Inbox extends DurableObject<Env> {
  private hits = new Map<WebSocket, number[]>()
  private lastPush = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // অন্য ইউজারের মেসেজ এখানে জমা হয়
    if (url.pathname === '/deliver') {
      const m = await req.json<any>()
      const pending = await this.ctx.storage.list({ prefix: 'msg:', limit: 500 })
      if (pending.size >= 500) return new Response('full', { status: 429 })
      const { uid, quiet, ...rest } = m // uid/quiet ক্লায়েন্টে বা স্টোরেজে যায় না
      const msg = { k: `msg:${m.ts}:${m.id}`, ...rest }
      await this.ctx.storage.put(msg.k, msg)
      for (const ws of this.ctx.getWebSockets())
        ws.send(JSON.stringify({ type: 'msg', ...msg }))
      if (!quiet && uid) this.ctx.waitUntil(this.push(uid)) // রিসিপ্টে নোটিফিকেশন নয়
      return new Response('ok')
    }

    if (req.headers.get('Upgrade') !== 'websocket')
      return new Response('Expected websocket', { status: 426 })

    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ username: req.headers.get('X-Username') })

    // অফলাইনে জমা থাকা মেসেজ পাঠিয়ে দিন
    const pending = await this.ctx.storage.list<any>({ prefix: 'msg:' })
    for (const msg of pending.values())
      server.send(JSON.stringify({ type: 'msg', ...msg }))

    return new Response(null, { status: 101, webSocket: client })
  }

  // পেলোড ছাড়া পুশ: ডিভাইস নিজে "নতুন মেসেজ" দেখায়। ৫ সেকেন্ডে একবারের বেশি নয়
  async push(uid: string) {
    const now = Date.now()
    if (now - this.lastPush < 5000) return
    this.lastPush = now
    const { results } = await this.env.DB.prepare('SELECT endpoint FROM push_subs WHERE user_id = ?')
      .bind(uid).all<{ endpoint: string }>()
    if (!results.length) return
    const v = await getVapid(this.env)
    for (const s of results) {
      const st = await sendPush(v, s.endpoint, this.env)
      if (st === 404 || st === 410) // ডিভাইস আর নেই
        await this.env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(s.endpoint).run()
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') return
    const me = ws.deserializeAttachment() as { username: string }
    let d: any
    try { d = JSON.parse(raw) } catch { return }

    // রিসিভ নিশ্চিত: এবার মুছে ফেলুন
    if (d.type === 'ack' && typeof d.k === 'string' && d.k.startsWith('msg:')) {
      await this.ctx.storage.delete(d.k)
      return
    }

    if (d.type === 'send') {
      const now = Date.now()
      const recent = (this.hits.get(ws) ?? []).filter(t => now - t < 10_000)
      if (recent.length >= 30)
        return ws.send(JSON.stringify({ type: 'error', id: d.id, error: 'অনেক দ্রুত মেসেজ পাঠাচ্ছেন, একটু থামুন' }))
      recent.push(now)
      this.hits.set(ws, recent)
      const bad = typeof d.to !== 'string' || typeof d.id !== 'string' ||
        d.id.length > 64 || typeof d.payload !== 'string' || d.payload.length > 100_000
      if (bad) return ws.send(JSON.stringify({ type: 'error', id: d.id, error: 'মেসেজ ঠিক নেই' }))

      const r = await this.env.DB.prepare('SELECT id FROM users WHERE username = ?')
        .bind(d.to).first<{ id: string }>()
      if (!r) return ws.send(JSON.stringify({ type: 'error', id: d.id, error: 'ইউজার পাওয়া যায়নি' }))

      const ts = Date.now()
      const res = await this.env.INBOX.get(this.env.INBOX.idFromName(r.id)).fetch('https://inbox/deliver', {
        method: 'POST',
        body: JSON.stringify({ id: d.id, ts, from: me.username, payload: d.payload, uid: r.id, quiet: d.quiet === true }),
      })
      if (!res.ok) return ws.send(JSON.stringify({ type: 'error', id: d.id, error: 'প্রাপকের ইনবক্স ভর্তি, পরে চেষ্টা করুন' }))
      ws.send(JSON.stringify({ type: 'sent', id: d.id, ts }))
    }
  }
}
