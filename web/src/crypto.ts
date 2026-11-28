import { call } from './api'

const KEYS = 'keys'
const MSGS = 'messages'
const enc = new TextEncoder()
const dec = new TextDecoder()

export const MAX_FILE = 20 * 1024 * 1024
export type Identity = { privateKey: CryptoKey; publicKeyB64: string }
export type FileMeta = { id: string; k: string; n: string; m: string; s: number; th?: string; d?: number }
export type Quote = { id: string; from: string; t: string }
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
// c: রিসিপ্ট, q: রিপ্লাই, fw: ফরওয়ার্ড, x: রিঅ্যাকশন, pn: পিন, ed: এডিট, dl: সবার থেকে ডিলিট
export type Body = {
  t?: string; f?: FileMeta; c?: { k: 'd' | 'r'; ids: string[] }
  q?: Quote; fw?: 1
  x?: { id: string; from: string; e: string }
  pn?: { id: string; from: string; on: boolean }
  ed?: { id: string; t: string }
  dl?: { id: string }
  rn?: { old: string } // নিজের username বদলের খবর
}
export type StoredMsg = {
  mid: string; owner: string; peer: string
  mine: boolean; text: string; ts: number; failed?: boolean
  file?: FileMeta; blob?: Blob; gone?: boolean
  status?: 'sending' | 'failed' | 'sent' | 'delivered' | 'read' // নিজের পাঠানো মেসেজ
  rd?: boolean // আসা মেসেজের জন্য 'পড়েছি' রিসিপ্ট পাঠানো হয়েছে
  q?: Quote; fw?: boolean; edited?: boolean; deleted?: boolean
  pinned?: number; reactions?: Record<string, string> // রিঅ্যাকশন: ইউজারনেম(ছোট হাতের) → ইমোজি
}

let dbPromise: Promise<IDBDatabase> | null = null
// একটাই কানেকশন ক্যাশ করা হয় (প্রতি অপারেশনে নতুন কানেকশন খুলে ফেলে রাখা হতো)
function openDB(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('securechat', 2)
    r.onupgradeneeded = () => {
      const db = r.result
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS)
      if (!db.objectStoreNames.contains(MSGS)) {
        db.createObjectStore(MSGS, { keyPath: 'mid' }).createIndex('owner', 'owner')
      }
    }
    r.onsuccess = () => {
      const db = r.result
      db.onversionchange = () => { db.close(); dbPromise = null }
      db.onclose = () => { dbPromise = null }
      res(db)
    }
    r.onerror = () => { dbPromise = null; rej(r.error) }
  }))
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
  const u = (await call('/api/users/' + encodeURIComponent(peer), 'GET', undefined, token)) as
    { username: string; publicKey: string | null; fullName?: string; avatar?: string | null; bio?: string
      hasCover?: boolean }
  // সর্বশেষ দেখা কী মনে রাখি: কেউ username বদলালে সত্যিই একই ব্যক্তি কিনা যাচাইয়ের জন্য
  if (u.publicKey) {
    const n = u.username.toLowerCase()
    localStorage.setItem('pk:' + n, u.publicKey)
    // প্রথমবার দেখা কী "পিন" করা হয়; পরে বদলালে সতর্কতা (ভেরিফাই না করা কন্টাক্টের জন্যও)
    if (!localStorage.getItem('pin:' + n)) localStorage.setItem('pin:' + n, u.publicKey)
  }
  return u
}
export const pinChanged = (peer: string) => {
  const n = peer.toLowerCase(), pin = localStorage.getItem('pin:' + n), cur = localStorage.getItem('pk:' + n)
  return !!pin && !!cur && pin !== cur
}
export const acceptKey = (peer: string) => {
  const n = peer.toLowerCase(), cur = localStorage.getItem('pk:' + n)
  if (cur) localStorage.setItem('pin:' + n, cur)
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

// পিয়ারের কী ক্যাশ ভুলে যাওয়া (ডিক্রিপ্ট ব্যর্থ হলে নতুন কী এনে আবার চেষ্টা করার জন্য)
export const forgetKey = (peer: string) => { cache.delete(peer.toLowerCase()) }

const aad = (from: string, to: string) => enc.encode(`${from.toLowerCase()}>${to.toLowerCase()}`)

export async function encryptBody(id: Identity, me: string, peer: string, token: string, body: Body) {
  const { key, username } = await sharedKey(id, peer, token)
  // কী বদলে গেলে (এবং এখনো মেনে নেওয়া না হলে) সাধারণ মেসেজ/ফাইল পাঠানো বন্ধ; রিসিপ্ট ও কন্ট্রোল মেসেজ চলে
  if ((body.t !== undefined || body.f) && pinChanged(username))
    throw new Error(`@${username}-এর নিরাপত্তা কী বদলেছে। চ্যাটের উপরের নোটিশ থেকে সেফটি নাম্বার মিলিয়ে "বুঝেছি, নতুন কী মেনে নিলাম" চাপুন`)
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
  const d = Number.isFinite(f.d) && f.d > 0 && f.d <= 3600 ? Math.round(f.d) : undefined
  return { id: f.id, k: f.k, n, m, s, th, d }
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
    const c = o.c
    if (c && (c.k === 'd' || c.k === 'r') && Array.isArray(c.ids))
      body.c = { k: c.k, ids: c.ids.filter((x: any) => typeof x === 'string' && x.length <= 64).slice(0, 50) }
    // আসা সব ডেটা অবিশ্বস্ত: কঠোরভাবে যাচাই
    const idOk = (v: any) => typeof v === 'string' && v.length > 0 && v.length <= 64 && !v.includes('|')
    const nameOk = (v: any) => typeof v === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(v)
    if (o.x && idOk(o.x.id) && nameOk(o.x.from) && typeof o.x.e === 'string' && (o.x.e === '' || REACTIONS.includes(o.x.e)))
      body.x = { id: o.x.id, from: o.x.from, e: o.x.e }
    if (o.pn && idOk(o.pn.id) && nameOk(o.pn.from) && typeof o.pn.on === 'boolean')
      body.pn = { id: o.pn.id, from: o.pn.from, on: o.pn.on }
    if (o.ed && idOk(o.ed.id) && typeof o.ed.t === 'string' && o.ed.t.length > 0)
      body.ed = { id: o.ed.id, t: o.ed.t.slice(0, 5000) }
    if (o.dl && idOk(o.dl.id)) body.dl = { id: o.dl.id }
    if (o.rn && nameOk(o.rn.old)) body.rn = { old: o.rn.old }
    if (o.q && idOk(o.q.id) && nameOk(o.q.from) && typeof o.q.t === 'string')
      body.q = { id: o.q.id, from: o.q.from, t: o.q.t.slice(0, 200) }
    if (o.fw === 1) body.fw = 1
    return body.t === undefined && !body.f && !body.c && !body.x && !body.pn && !body.ed && !body.dl && !body.rn ? null : body
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
// একই ট্রানজাকশনে পড়া+লেখা (ডাউনলোড করা ফাইল হারাবে না); স্ট্যাটাস শুধু উপরের দিকে যায়
const RANK: Record<string, number> = { sending: 0, failed: 1, sent: 2, delivered: 3, read: 4 }
export async function patchMessage(mid: string, patch: Partial<StoredMsg>) {
  const db = await openDB()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(MSGS, 'readwrite')
    const s = tx.objectStore(MSGS)
    const g = s.get(mid)
    g.onsuccess = () => {
      const cur = g.result as StoredMsg | undefined
      if (!cur) return
      const p = { ...patch }
      if (p.status && RANK[p.status] <= RANK[cur.status ?? 'sent']) delete p.status
      s.put({ ...cur, ...p })
    }
    tx.oncomplete = () => res()
    tx.onerror = tx.onabort = () => rej(tx.error)
  })
}
export const getMessage = (mid: string) => idb<StoredMsg | undefined>(MSGS, 'readonly', s => s.get(mid))

export async function loadMessages(owner: string) {
  const all = await idb<StoredMsg[]>(MSGS, 'readonly',
    s => s.index('owner').getAll(owner.toLowerCase()))
  return all.sort((a, b) => a.ts - b.ts)
}

// আইডেন্টিটি এখন ইউজার id দিয়ে রাখা হয়। আগের (username দিয়ে রাখা) কী থাকলে সেটাই নেওয়া হয়
// takeover: সরাসরি লগইনের সময় true। তখন এই ডিভাইসের কী-ই সার্ভারে বসে (অন্য ডিভাইস পুরনো হয়ে যায়)।
// পেজ রিফ্রেশে false: সার্ভারের কী আলাদা হলে চুপচাপ কেড়ে না নিয়ে Messenger সতর্কতা দেখায়।
export async function ensureIdentity(id: string, username: string, token: string,
  serverKey: string | null = null, takeover = false) {
  let ident = (await loadIdentity(id)) ?? (username ? await loadIdentity(username) : undefined)
  if (!ident) {
    ident = await generateIdentity()
    await call('/api/key', 'PUT', { publicKey: ident.publicKeyB64 }, token)
  } else if (takeover && serverKey !== ident.publicKeyB64) {
    await call('/api/key', 'PUT', { publicKey: ident.publicKeyB64 }, token)
  }
  await saveIdentity(id, ident)
  return ident
}

// অ্যাকাউন্ট ডিলিটের পর এই ডিভাইসের কী মুছে ফেলা
export async function deleteIdentity(id: string, username: string) {
  await idb(KEYS, 'readwrite', s => s.delete('identity:' + id.toLowerCase()))
  await idb(KEYS, 'readwrite', s => s.delete('identity:' + username.toLowerCase()))
}

// একই ট্রানজাকশনে পড়ে-বদলে-লেখা (রিঅ্যাকশন, এডিট ইত্যাদি একসঙ্গে এলেও কিছু হারায় না)
export async function mutateMessage(mid: string, fn: (m: StoredMsg) => StoredMsg): Promise<StoredMsg | undefined> {
  const db = await openDB()
  return new Promise((res, rej) => {
    const tx = db.transaction(MSGS, 'readwrite')
    const s = tx.objectStore(MSGS)
    let out: StoredMsg | undefined
    const g = s.get(mid)
    g.onsuccess = () => {
      const cur = g.result as StoredMsg | undefined
      if (!cur) return
      out = fn(cur)
      s.put(out)
    }
    tx.oncomplete = () => res(out)
    tx.onerror = tx.onabort = () => rej(tx.error)
  })
}
export const deleteMessage = (mid: string) => idb(MSGS, 'readwrite', s => s.delete(mid))

// শুধু এই ডিভাইসের সংরক্ষিত মেসেজ মুছে ফেলে (সার্ভার বা অন্যের ডিভাইসে প্রভাব নেই)
export async function clearMessages(owner: string) {
  const db = await openDB()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(MSGS, 'readwrite')
    const s = tx.objectStore(MSGS)
    const c = s.index('owner').openKeyCursor(IDBKeyRange.only(owner.toLowerCase()))
    c.onsuccess = () => {
      const cur = c.result
      if (cur) { s.delete(cur.primaryKey); cur.continue() }
    }
    tx.oncomplete = () => res()
    tx.onerror = tx.onabort = () => rej(tx.error)
  })
}

// শুধু এই ডিভাইসের একটা চ্যাটের সব মেসেজ মোছে (অন্যের ডিভাইসে প্রভাব নেই)
export async function deleteChat(owner: string, peer: string) {
  const db = await openDB()
  const p = peer.toLowerCase()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(MSGS, 'readwrite')
    const s = tx.objectStore(MSGS)
    const c = s.index('owner').openCursor(IDBKeyRange.only(owner.toLowerCase()))
    c.onsuccess = () => {
      const cur = c.result
      if (!cur) return
      if ((cur.value as StoredMsg).peer.toLowerCase() === p) cur.delete()
      cur.continue()
    }
    tx.oncomplete = () => res()
    tx.onerror = tx.onabort = () => rej(tx.error)
  })
}

// ---- username বদলের সময় এই ডিভাইসের ডেটা নতুন নামে সরানো ----
function moveKeys(from: string, to: string, prefix: boolean) {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i)
    if (!k || !(prefix ? k.startsWith(from) : k === from)) continue
    const v = localStorage.getItem(k)!
    localStorage.removeItem(k)
    localStorage.setItem(to + k.slice(from.length), v)
  }
}

function rewrite(fn: (m: StoredMsg, cur: IDBCursorWithValue, s: IDBObjectStore) => void, owner: string) {
  return openDB().then(db => new Promise<void>((res, rej) => {
    const tx = db.transaction(MSGS, 'readwrite')
    const s = tx.objectStore(MSGS)
    const c = s.index('owner').openCursor(IDBKeyRange.only(owner))
    c.onsuccess = () => {
      const cur = c.result
      if (!cur) return
      fn(cur.value as StoredMsg, cur, s)
      cur.continue()
    }
    tx.oncomplete = () => res()
    tx.onerror = tx.onabort = () => rej(tx.error)
  }))
}

const rekey = (r: Record<string, string> | undefined, from: string, to: string) => {
  if (!r || !(from in r)) return r
  const n = { ...r }
  n[to] = n[from]
  delete n[from]
  return n
}

// নিজের username বদলালে: owner, mid, রিঅ্যাকশন কী ও কোট নতুন নামে
export async function renameOwner(oldName: string, newName: string) {
  const o = oldName.toLowerCase(), n = newName.toLowerCase()
  if (o === n) return
  await rewrite((m, cur, s) => {
    cur.delete()
    s.put({
      ...m, owner: n, mid: n + m.mid.slice(o.length),
      reactions: rekey(m.reactions, o, n),
      q: m.q && m.q.from.toLowerCase() === o ? { ...m.q, from: newName } : m.q,
    })
  }, o)
  moveKeys(`read:${o}:`, `read:${n}:`, true)
  moveKeys(`verified:${o}:`, `verified:${n}:`, true)
}

// কন্টাক্ট username বদলালে: তার সব মেসেজ নতুন নামের চ্যাটে সরানো
export async function renamePeer(owner: string, oldPeer: string, newPeer: string) {
  const ow = owner.toLowerCase(), o = oldPeer.toLowerCase(), n = newPeer.toLowerCase()
  if (o === n) return
  await rewrite((m, cur, s) => {
    let u: StoredMsg = m
    if (m.peer.toLowerCase() === o) {
      const oldIn = `${ow}|in|${o}|`
      u = {
        ...u, peer: newPeer, reactions: rekey(u.reactions, o, n),
        mid: m.mid.startsWith(oldIn) ? `${ow}|in|${n}|` + m.mid.slice(oldIn.length) : m.mid,
      }
    }
    if (u.q && u.q.from.toLowerCase() === o) u = { ...u, q: { ...u.q, from: newPeer } }
    if (u === m) return
    if (u.mid !== m.mid) cur.delete()
    s.put(u)
  }, ow)
  moveKeys(`pin:${o}`, `pin:${n}`, false)
  moveKeys(`read:${ow}:${o}`, `read:${ow}:${n}`, false)
  moveKeys(`verified:${ow}:${o}`, `verified:${ow}:${n}`, false)
}
