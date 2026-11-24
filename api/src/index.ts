import { DurableObject } from 'cloudflare:workers'

export interface Env {
  DB: D1Database
  INBOX: DurableObjectNamespace
  MEDIA: R2Bucket
  ALLOWED_ORIGIN?: string
}

const MAX_UPLOAD = 26 * 1024 * 1024 // ২৫ MB ফাইল + IV/ট্যাগ
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const enc = new TextEncoder()

// প্রতিটি রিকোয়েস্টের শুরুতে env থেকে সেট হয় (মান সবসময় একই)
let cors: Record<string, string> = {}
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    }
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
    const { pathname } = new URL(req.url)

    try {
      if (pathname === '/api/register' && req.method === 'POST') {
        const { username, password, publicKey } = await readJson(req)
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || ''))
          return json({ error: 'Username ৩-২০ অক্ষর, শুধু ইংরেজি অক্ষর/সংখ্যা/_' }, 400)
        if (!password || typeof password !== 'string' || password.length < 8)
          return json({ error: 'Password কমপক্ষে ৮ অক্ষর' }, 400)
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

      if (pathname === '/api/ws') {
        if (req.headers.get('Upgrade') !== 'websocket')
          return json({ error: 'Expected websocket' }, 426)
        const allowed = env.ALLOWED_ORIGIN
        const origin = req.headers.get('Origin')
        if (allowed && allowed !== '*' && origin && origin !== allowed)
          return json({ error: 'Forbidden origin' }, 403)
        const token = new URL(req.url).searchParams.get('token') || ''
        const user = await authToken(token, env)
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
        const to = new URL(req.url).searchParams.get('to') || ''
        const rcpt = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
          .bind(to).first<{ id: string }>()
        if (!rcpt) return json({ error: 'ইউজার পাওয়া যায়নি' }, 404)

        const len = Number(req.headers.get('Content-Length') || 0)
        if (!len || len > MAX_UPLOAD) return json({ error: 'ফাইল সর্বোচ্চ ২৫ MB হতে পারবে' }, 413)
        const body = await req.arrayBuffer()
        if (body.byteLength > MAX_UPLOAD) return json({ error: 'ফাইল সর্বোচ্চ ২৫ MB হতে পারবে' }, 413)

        const id = crypto.randomUUID()
        await env.MEDIA.put(id, body, { customMetadata: { from: user.id, to: rcpt.id } })
        return json({ id })
      }

      const mm = pathname.match(/^\/api\/media\/([0-9a-f-]{36})$/)
      if (mm && UUID.test(mm[1])) {
        const user = await authUser(req, env)
        if (!user) return json({ error: 'Unauthorized' }, 401)
        const allowedMeta = (meta?: Record<string, string>) => meta?.to === user.id || meta?.from === user.id

        if (req.method === 'GET') {
          const obj = await env.MEDIA.get(mm[1])
          if (!obj || !allowedMeta(obj.customMetadata)) return json({ error: 'ফাইল পাওয়া যায়নি' }, 404)
          return new Response(obj.body, {
            headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', ...cors },
          })
        }
        if (req.method === 'DELETE') {
          const head = await env.MEDIA.head(mm[1])
          if (head && allowedMeta(head.customMetadata)) await env.MEDIA.delete(mm[1])
          return json({ ok: true })
        }
      }

      return json({ error: 'Not found' }, 404)
    } catch (e) {
      console.error(e)
      return json({ error: 'সার্ভারে সমস্যা হয়েছে' }, 500)
    }
  },
}

export class Inbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // অন্য ইউজারের মেসেজ এখানে জমা হয়
    if (url.pathname === '/deliver') {
      const m = await req.json<any>()
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
      const bad = typeof d.to !== 'string' || typeof d.id !== 'string' ||
        d.id.length > 64 || typeof d.payload !== 'string' || d.payload.length > 100_000
      if (bad) return ws.send(JSON.stringify({ type: 'error', id: d.id, error: 'মেসেজ ঠিক নেই' }))

      const r = await this.env.DB.prepare('SELECT id FROM users WHERE username = ?')
        .bind(d.to).first<{ id: string }>()
      if (!r) return ws.send(JSON.stringify({ type: 'error', id: d.id, error: 'ইউজার পাওয়া যায়নি' }))

      const ts = Date.now()
      await this.env.INBOX.get(this.env.INBOX.idFromName(r.id)).fetch('https://inbox/deliver', {
        method: 'POST',
        body: JSON.stringify({ id: d.id, ts, from: me.username, payload: d.payload }),
      })
      ws.send(JSON.stringify({ type: 'sent', id: d.id, ts }))
    }
  }
}
