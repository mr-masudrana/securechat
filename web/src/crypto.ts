import { call } from './api'

const KEYS = 'keys'
const MSGS = 'messages'
const enc = new TextEncoder()
const dec = new TextDecoder()

export const MAX_FILE = 25 * 1024 * 1024
export type Identity = { privateKey: CryptoKey; publicKeyB64: string }
export type FileMeta = { id: string; k: string; n: string; m: string; s: number; th?: string }
export type Body = { t?: string; f?: FileMeta }
export type StoredMsg = {
  mid: string; owner: string; peer: string
  mine: boolean; text: string; ts: number; failed?: boolean
  file?: FileMeta; blob?: Blob; gone?: boolean
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('securechat', 2)
    r.onupgradeneeded = () => {
      const db = r.result
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS)
      if (!db.objectStoreNames.contains(MSGS)) {
        db.createObjectStore(MSGS, { keyPath: 'mid' }).createIndex('owner', 'owner')
      }
    }
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}

async function idb<T>(store: string, mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDB()
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    tx.oncomplete = () => res(req.result as T) // সেভ নিশ্চিত হওয়ার পরেই রিটার্ন
    tx.onerror = () => rej(tx.error)
    tx.onabort = () => rej(tx.error)
  })
}

const toB64 = (b: ArrayBuffer | Uint8Array) => {
  const u = new Uint8Array(b)
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

// ---------- আইডেন্টিটি ----------
export async function generateIdentity(): Promise<Identity> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
  return { privateKey: pair.privateKey, publicKeyB64: toB64(raw) }
}
export const saveIdentity = (user: string, id: Identity) =>
  idb(KEYS, 'readwrite', s => s.put(id, 'identity:' + user.toLowerCase()))
export const loadIdentity = (user: string) =>
  idb<Identity | undefined>(KEYS, 'readonly', s => s.get('identity:' + user.toLowerCase()))

export async function fingerprint(pubB64: string) {
  const d = await crypto.subtle.digest('SHA-256', fromB64(pubB64))
  return [...new Uint8Array(d)].slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0')).join(' ')
}

export async function lookupUser(peer: string, token: string) {
  return (await call('/api/users/' + encodeURIComponent(peer), 'GET', undefined, token)) as
    { username: string; publicKey: string | null }
}

// দুজনের কী থেকে একই নাম্বার তৈরি হয়, দুই পাশে মিললে মাঝখানে কেউ কী বদলায়নি
export async function safetyNumber(myPub: string, peerPub: string) {
  const [a, b] = [myPub, peerPub].sort()
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a + b)))
  return Array.from({ length: 12 }, (_, i) =>
    String((d[i * 2] << 8) | d[i * 2 + 1]).padStart(5, '0')).join(' ')
}

// ---------- শেয়ার্ড কী ----------
type Shared = { key: CryptoKey; username: string; at: number }
const cache = new Map<string, Shared>()

async function sharedKey(id: Identity, peer: string, token: string): Promise<Shared> {
  const name = peer.toLowerCase()
  const hit = cache.get(name)
  // ৬০ সেকেন্ডের বেশি পুরনো হলে আবার আনুন, কারণ পিয়ার নতুন ব্রাউজারে লগইন করলে কী বদলায়
  if (hit && Date.now() - hit.at < 60_000) return hit
  const r = await lookupUser(peer, token)
  if (!r.publicKey) throw new Error('এই ইউজারের এনক্রিপশন কী নেই')
  const pub = await crypto.subtle.importKey(
    'raw', fromB64(r.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const key = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: pub }, id.privateKey,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const v = { key, username: r.username, at: Date.now() }
  cache.set(name, v)
  return v
}

const aad = (from: string, to: string) => enc.encode(`${from.toLowerCase()}>${to.toLowerCase()}`)

export async function encryptBody(id: Identity, me: string, peer: string, token: string, body: Body) {
  const { key, username } = await sharedKey(id, peer, token)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(me, username) },
    key, enc.encode(JSON.stringify(body)))
  return { payload: toB64(iv) + '.' + toB64(ct), peer: username }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// প্রেরকের পাঠানো সব ডেটা অবিশ্বস্ত, তাই যাচাই করে নিই
function cleanFile(f: any): FileMeta | undefined {
  if (!f || typeof f !== 'object') return
  if (typeof f.id !== 'string' || !UUID_RE.test(f.id)) return
  if (typeof f.k !== 'string' || f.k.length !== 44) return
  const n = String(f.n ?? 'file').replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || 'file'
  const m = typeof f.m === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(f.m) ? f.m.slice(0, 100) : 'application/octet-stream'
  const s = Number.isFinite(f.s) && f.s >= 0 && f.s <= MAX_FILE ? f.s : 0
  const th = typeof f.th === 'string' && f.th.startsWith('data:image/jpeg;base64,') && f.th.length < 60_000
    ? f.th : undefined
  return { id: f.id, k: f.k, n, m, s, th }
}

// নেটওয়ার্ক সমস্যায় throw করে। ডিক্রিপ্ট ব্যর্থ হলে null দেয়।
export async function decryptBody(id: Identity, me: string, from: string, token: string, payload: string): Promise<Body | null> {
  const { key } = await sharedKey(id, from, token)
  try {
    const [iv, ct] = payload.split('.')
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(iv), additionalData: aad(from, me) }, key, fromB64(ct))
    const o = JSON.parse(dec.decode(buf))
    const body: Body = {}
    if (typeof o.t === 'string') body.t = o.t.slice(0, 5000)
    const f = cleanFile(o.f)
    if (f) body.f = f
    return body.t === undefined && !body.f ? null : body
  } catch {
    return null
  }
}

// ---------- ফাইল এনক্রিপশন ----------
export async function encryptFile(plain: ArrayBuffer) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv); out.set(ct, 12)
  return { data: out.buffer as ArrayBuffer, k: toB64(await crypto.subtle.exportKey('raw', key)) }
}

export async function decryptFile(data: ArrayBuffer, k: string) {
  const key = await crypto.subtle.importKey('raw', fromB64(k), 'AES-GCM', false, ['decrypt'])
  const b = new Uint8Array(data)
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12))
}

// ---------- লোকাল মেসেজ ----------
export const saveMessage = (m: StoredMsg) => idb(MSGS, 'readwrite', s => s.put(m))
export const getMessage = (mid: string) => idb<StoredMsg | undefined>(MSGS, 'readonly', s => s.get(mid))

export async function loadMessages(owner: string) {
  const all = await idb<StoredMsg[]>(MSGS, 'readonly',
    s => s.index('owner').getAll(owner.toLowerCase()))
  return all.sort((a, b) => a.ts - b.ts)
}
