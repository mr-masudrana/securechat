import { DurableObject } from 'cloudflare:workers'

export interface Env {
  DB: D1Database
  INBOX: DurableObjectNamespace
  MEDIA: KVNamespace
  ALLOWED_ORIGIN?: string
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
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await sha256(token), Date.now()).first<{ id: string; username: string }>()
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
        const { username, password, publicKey } = await readJson(req)
        if (await limited(env, `reg:${ip}`, 10, 3600)) return json(tooMany, 429)
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || ''))
          return json({ error: 'Username ৩-২০ অক্ষর, শুধু ইংরেজি অক্ষর/সংখ্যা/_' }, 400)
        if (!password || typeof password !== 'string' || password.length < 8 || password.length > 200)
          return json({ error: 'Password ৮ থেকে ২০০ অক্ষরের হতে হবে' }, 400)
        if (typeof publicKey !== 'string' || publicKey.length !== 88)
          return json({ error: 'পাবলিক কী ঠিক নেই' }, 400)

        const salt = crypto.getRandomValues(new Uint8Array(16))
        const id = crypto.randomUUID()
        try {
          await env.DB.prepare(
            'INSERT INTO users (id, username, pass_hash, salt, created_at, public_key) VALUES (?,?,?,?,?,?)')
            .bind(id, username, await hashPw(password, salt), b64(salt), Date.now(), publicKey).run()
        } catch {
          return json({ error: 'এই username নেওয়া হয়ে গেছে' }, 409)
        }
        return json({ token: await newSession(env, id), username })
      }

      if (pathname === '/api/login' && req.method === 'POST') {
        const { username, password } = await readJson(req)
        if (await limited(env, `login-ip:${ip}`, 30, 300) ||
            await limited(env, `login-user:${String(username).toLowerCase()}`, 10, 900))
          return json(tooMany, 429)
        const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
          .bind(typeof username === 'string' ? username : '').first<any>()
        const ok = u && (await hashPw(String(password || ''), unb64(u.salt))) === u.pass_hash
        if (!ok) return json({ error: 'Username বা password ভুল' }, 401)
        return json({ token: await newSession(env, u.id), username: u.username, publicKey: u.public_key })
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
        return user ? json(user) : json({ error: 'Unauthorized' }, 401)
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
        const u = await env.DB.prepare('SELECT username, public_key FROM users WHERE username = ?')
          .bind(name).first<any>()
        return u ? json({ username: u.username, publicKey: u.public_key }) : json({ error: 'Not found' }, 404)
      }

      if (pathname === '/api/media' && req.method === 'POST') {
        const user = await authUser(req, env)
        if (!user) return json({ error: 'Unauthorized' }, 401)
        if (await limited(env, `media:${user.id}`, 60, 60)) return json(tooMany, 429)
        const to = new URL(req.url).searchParams.get('to') || ''
        const rcpt = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
          .bind(to).first<{ id: string }>()
        if (!rcpt) return json({ error: 'ইউজার পাওয়া যায়নি' }, 404)

        const len = Number(req.headers.get('Content-Length') || 0)
        if (!len || len > MAX_UPLOAD) return json({ error: 'ফাইল সর্বোচ্চ ২০ MB হতে পারবে' }, 413)
        const body = await req.arrayBuffer()
        if (body.byteLength > MAX_UPLOAD) return json({ error: 'ফাইল সর্বোচ্চ ২০ MB হতে পারবে' }, 413)

        const id = crypto.randomUUID()
        await env.MEDIA.put(id, body, {
          metadata: { from: user.id, to: rcpt.id },
          expirationTtl: 30 * 24 * 3600, // ৩০ দিনে নিজে মুছে যাবে
        })
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
      return json({ error: 'সার্ভারে সমস্যা হয়েছে' }, 500)
    }
  },

  // প্রতিদিন মেয়াদোত্তীর্ণ সেশন, টিকেট ও কাউন্টার মুছে ফেলে
  async scheduled(_e: ScheduledController, env: Env) {
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM ws_tickets WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(now),
    ])
  },
}

export class Inbox extends DurableObject<Env> {
  private hits = new Map<WebSocket, number[]>()

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
      const msg = { k: `msg:${m.ts}:${m.id}`, ...m }
      await this.ctx.storage.put(msg.k, msg)
      for (const ws of this.ctx.getWebSockets())
        ws.send(JSON.stringify({ type: 'msg', ...msg }))
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
        body: JSON.stringify({ id: d.id, ts, from: me.username, payload: d.payload }),
      })
      if (!res.ok) return ws.send(JSON.stringify({ type: 'error', id: d.id, error: 'প্রাপকের ইনবক্স ভর্তি, পরে চেষ্টা করুন' }))
      ws.send(JSON.stringify({ type: 'sent', id: d.id, ts }))
    }
  }
}
