import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode, type TouchEvent } from 'react'
import { connect, type Conn } from './socket'
import { call, downloadBlob, uploadBlob } from './api'
import {
  decryptBody, decryptFile, encryptBody, encryptFile, clearMessages, deleteMessage, renameOwner, renamePeer, getMessage, loadMessages, lookupUser, mutateMessage, REACTIONS,
  MAX_FILE, patchMessage, safetyNumber, saveMessage, type Body, type FileMeta, type Quote, type StoredMsg,
} from './crypto'
import { fmtDur, fmtSize, isAudio, isImg, makeThumb, prepareImage, previewText, resizeAvatar, safeType } from './media'
import { useProfile } from './profiles'
import Icon, { type IconName } from './Icon'
import { beep, readReceiptsOn, soundOn } from './notify'
import { syncPush } from './push'
import NotifDialog from './NotifDialog'
import { AccountDialog, PrivacyDialog } from './MenuDialogs'
import type { Session } from './types'

const AUTO_MAX = 10 * 1024 * 1024
type DlState = Record<string, 'loading' | 'error'>
type Actions = {
  react: (m: StoredMsg, e: string) => Promise<void>
  pin: (m: StoredMsg) => Promise<void>
  edit: (m: StoredMsg, text: string) => Promise<boolean>
  del: (m: StoredMsg, everyone: boolean) => Promise<void>
  forward: (m: StoredMsg, peer: string) => Promise<boolean>
}
const EDIT_WINDOW = 15 * 60_000
const idOf = (m: StoredMsg) => m.mid.split('|').pop()!
// "সবার থেকে ডিলিট" হলে বিষয়বস্তু মুছে শুধু চিহ্ন থাকে
const tomb = (m: StoredMsg): StoredMsg => ({
  ...m, deleted: true, text: '', file: undefined, blob: undefined, gone: undefined,
  q: undefined, fw: undefined, reactions: undefined, pinned: undefined,
})
type Status = NonNullable<StoredMsg['status']>
const RANK: Record<Status, number> = { sending: 0, failed: 1, sent: 2, delivered: 3, read: 4 }

const mergeAll = (cur: StoredMsg[], add: StoredMsg[]) => {
  const ids = new Set(cur.map(x => x.mid))
  return [...cur, ...add.filter(x => !ids.has(x.mid))].sort((a, b) => a.ts - b.ts)
}
const hhmm = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
// চ্যাটের তারিখ-লেবেল: আজ / গতকাল / সপ্তাহের বার / পুরো তারিখ
const dayKey = (ts: number) => new Date(ts).toDateString()
function dayLabel(ts: number) {
  const d = new Date(ts)
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((start(new Date()) - start(d)) / 86400000)
  if (diff === 0) return 'আজ'
  if (diff === 1) return 'গতকাল'
  if (diff > 1 && diff < 7) return d.toLocaleDateString('bn-BD', { weekday: 'long' })
  return d.toLocaleDateString('bn-BD', { day: 'numeric', month: 'long', year: 'numeric' })
}
const DayChip = ({ ts }: { ts: number }) => (
  <div className="flex justify-center py-2">
    <span className="px-3 py-1 rounded-lg bg-slate-800 text-xs text-slate-300">{dayLabel(ts)}</span>
  </div>
)
// চ্যাট লিস্টে: আজ হলে সময়, গতকাল হলে "গতকাল", নইলে তারিখ
const listTime = (ts: number) => {
  const l = dayLabel(ts)
  return l === 'আজ' ? hhmm(ts) : l === 'গতকাল' ? l : new Date(ts).toLocaleDateString('bn-BD', { day: 'numeric', month: 'short' })
}
const Avatar = ({ name, src }: { name: string; src?: string | null }) => src
  ? <img src={src} alt="" className="size-11 shrink-0 rounded-full object-cover" />
  : (
    <div className="size-11 shrink-0 rounded-full bg-emerald-700 grid place-items-center font-bold uppercase">
      {name[0]}
    </div>
  )
const PeerAvatar = ({ peer, token }: { peer: string; token: string }) => {
  const p = useProfile(peer, token)
  return <Avatar name={peer} src={p?.avatar} />
}

const Tick = ({ s }: { s?: Status }) => (
  <span className="ml-1 inline-flex align-middle">
    {s === 'sending' ? <Icon name="clock" className="size-3" />
      : s === 'failed' ? <Icon name="alert" className="size-3 text-red-300" />
      : s === 'read' ? <Icon name="checks" className="size-3.5 text-sky-300" />
      : s === 'delivered' ? <Icon name="checks" className="size-3.5" />
      : <Icon name="check" className="size-3.5" />}
  </span>
)

// খোলা চ্যাট URL-এর হ্যাশে থাকে (#c/username): রিফ্রেশে ফিরে আসে, ব্যাক বাটনে লিস্টে যায়
const fromHash = () => {
  const m = location.hash.match(/^#c\/(.+)$/)
  try { return m ? decodeURIComponent(m[1]) : null } catch { return null }
}

export default function Messenger({ session, onLogout, onSession }: {
  session: Session; onLogout: () => void; onSession: (p: Partial<Session>) => void
}) {
  const { username, token, identity } = session
  const owner = username.toLowerCase()
  const [msgs, setMsgs] = useState<StoredMsg[]>([])
  const [online, setOnline] = useState(false)
  const [active, setActive] = useState<string | null>(fromHash)
  const [reads, setReads] = useState<Record<string, number>>({})
  const [toast, setToast] = useState('')
  const [newChat, setNewChat] = useState(false)
  const [newName, setNewName] = useState('')
  const [dl, setDl] = useState<DlState>({})
  const [myAvatar, setMyAvatar] = useState(session.avatar)
  const [showNotif, setShowNotif] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showAccount, setShowAccount] = useState(false)
  const [showPrivacy, setShowPrivacy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const changeUsername = async (name: string, current: string) => {
    const r = await call('/api/account/username', 'POST', { username: name, current }, token)
    await renameOwner(username, r.username) // এই ডিভাইসের ইতিহাস নতুন নামে সরানো
    if (r.username.toLowerCase() !== owner)
      localStorage.setItem('rename-pending:' + r.username.toLowerCase(), JSON.stringify({ old: username }))
    onSession({ username: r.username }) // অ্যাপ নতুন নামে আবার চালু হবে
  }
  // নতুন নামে চালু হয়ে সব কন্টাক্টকে (এনক্রিপ্টেড কন্ট্রোল মেসেজে) জানানো
  useEffect(() => {
    const key = 'rename-pending:' + owner
    const raw = localStorage.getItem(key)
    if (!raw || !online || !loaded) return
    let old = ''
    try { old = JSON.parse(raw).old } catch { localStorage.removeItem(key); return }
    const peers = [...new Set(msgsRef.current.map(m => m.peer))]
    void (async () => {
      let ok = true
      for (const p of peers) ok = (await sendControl(p, { rn: { old } })) && ok
      if (ok) localStorage.removeItem(key)
    })()
  }, [online, loaded])
  const clearAll = async () => {
    await clearMessages(username)
    setMsgs([])
    if (activeRef.current) closeChat()
  }
  const goMenu = (k: 'account' | 'privacy' | 'settings' | 'logout') => {
    setMenuOpen(false)
    if (k === 'account') setShowAccount(true)
    else if (k === 'privacy') setShowPrivacy(true)
    else if (k === 'settings') setShowNotif(true)
    else onLogout()
  }
  const changeAvatar = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const a = await resizeAvatar(f)
      await call('/api/profile', 'POST', { avatar: a }, token)
      setMyAvatar(a)
    } catch (err: any) { setToast(err.message || 'ছবি বদলানো যায়নি') }
  }
  const dlBusy = useRef(new Set<string>())
  const conn = useRef<Conn | null>(null)
  const activeRef = useRef<string | null>(null)
  activeRef.current = active
  const msgsRef = useRef<StoredMsg[]>([])
  msgsRef.current = msgs
  const rcQueue = useRef<Record<string, { d: Set<string>; r: Set<string> }>>({})
  const rcTimer = useRef(0)

  // রিসিপ্ট (পৌঁছেছে/পড়েছে) এনক্রিপ্টেড মেসেজ হিসেবে যায়, কয়েকটা জুড়ে একসঙ্গে
  const flushReceipts = async () => {
    const all = rcQueue.current
    rcQueue.current = {}
    for (const [peer, q] of Object.entries(all)) {
      for (const k of ['d', 'r'] as const) {
        const ids = [...q[k]]
        for (let i = 0; i < ids.length; i += 50) {
          if (!conn.current?.isOpen()) return
          try {
            const { payload, peer: canon } = await encryptBody(identity, username, peer, token,
              { c: { k, ids: ids.slice(i, i + 50) } })
            conn.current.send(canon, payload, undefined, true) // রিসিপ্টে পুশ নয়
          } catch { /* রিসিপ্ট হারালে শুধু টিক আপডেট হয় না */ }
        }
      }
    }
  }
  const queueReceipt = (peer: string, k: 'd' | 'r', id: string) => {
    const q = (rcQueue.current[peer] ??= { d: new Set(), r: new Set() })
    q[k].add(id)
    clearTimeout(rcTimer.current)
    rcTimer.current = window.setTimeout(flushReceipts, 500)
  }
  // from দিলে শুধু ওই পিয়ারের পাঠানো রিসিপ্ট মানা হয় (অন্যজন ভুয়া টিক দিতে পারবে না)
  const setStatus = async (mid: string, st: Status, from?: string) => {
    const cur = await getMessage(mid)
    if (!cur || !cur.mine || (from && cur.peer.toLowerCase() !== from.toLowerCase())) return
    await patchMessage(mid, { status: st })
    setMsgs(l => l.map(x =>
      x.mid === mid && RANK[st] > RANK[x.status ?? 'sent'] ? { ...x, status: st } : x))
  }
  const sendReads = (peer: string) => {
    const todo = msgsRef.current.filter(m =>
      !m.mine && !m.failed && !m.rd && m.peer.toLowerCase() === peer.toLowerCase())
    if (!todo.length) return
    todo.forEach(m => {
      if (readReceiptsOn()) queueReceipt(peer, 'r', m.mid.split('|')[3]) // প্রাইভেসি সেটিং
      void patchMessage(m.mid, { rd: true })
    })
    const ids = new Set(todo.map(m => m.mid))
    setMsgs(l => l.map(x => (ids.has(x.mid) ? { ...x, rd: true } : x)))
  }
  // ---- মেসেজ অ্যাকশন: রিঅ্যাক্ট, এডিট, ডিলিট, পিন, ফরওয়ার্ড (সবই এনক্রিপ্টেড কন্ট্রোল মেসেজ) ----
  const apply = async (mid: string, fn: (m: StoredMsg) => StoredMsg) => {
    const upd = await mutateMessage(mid, fn)
    if (upd) setMsgs(l => l.map(x => (x.mid === mid ? upd : x)))
    return upd
  }
  const sendControl = async (peer: string, body: Body) => {
    if (!conn.current?.isOpen()) { setToast('কানেকশন নেই, একটু পরে চেষ্টা করুন'); return false }
    try {
      const { payload, peer: canon } = await encryptBody(identity, username, peer, token, body)
      return !!conn.current.send(canon, payload, undefined, true) // নোটিফিকেশন নয়
    } catch (e: any) { setToast(e.message); return false }
  }
  const senderOf = (m: StoredMsg) => (m.mine ? username : m.peer)

  const react = async (m: StoredMsg, e: string) => {
    const next = m.reactions?.[owner] === e ? '' : e // একই ইমোজি আবার চাপলে সরে যায়
    if (!(await sendControl(m.peer, { x: { id: idOf(m), from: senderOf(m), e: next } }))) return
    await apply(m.mid, cur => {
      const r = { ...(cur.reactions ?? {}) }
      if (next) r[owner] = next; else delete r[owner]
      return { ...cur, reactions: r }
    })
  }
  const pin = async (m: StoredMsg) => {
    const on = !m.pinned
    if (!(await sendControl(m.peer, { pn: { id: idOf(m), from: senderOf(m), on } }))) return
    await apply(m.mid, cur => ({ ...cur, pinned: on ? Date.now() : undefined }))
  }
  const edit = async (m: StoredMsg, text: string) => {
    if (!m.mine || m.file || m.deleted || Date.now() - m.ts > EDIT_WINDOW) { setToast('এই মেসেজ এডিট করা যাবে না'); return false }
    if (!(await sendControl(m.peer, { ed: { id: idOf(m), t: text } }))) return false
    await apply(m.mid, cur => ({ ...cur, text, edited: true }))
    return true
  }
  const del = async (m: StoredMsg, everyone: boolean) => {
    if (everyone && m.mine) {
      if (!(await sendControl(m.peer, { dl: { id: idOf(m) } }))) return
      if (m.file) call('/api/media/' + m.file.id, 'DELETE', undefined, token).catch(() => {})
      await apply(m.mid, tomb)
    } else {
      await deleteMessage(m.mid)
      setMsgs(l => l.filter(x => x.mid !== m.mid))
    }
  }
  const forward = async (m: StoredMsg, peer: string) => {
    if (m.deleted) return false
    if (m.file) {
      if (!m.blob) { setToast('আগে ফাইলটা ডাউনলোড করুন'); return false }
      return sendFile(peer, new File([m.blob], m.file.n, { type: m.file.m }), m.text, m.file.d, undefined, true)
    }
    return sendText(peer, m.text, undefined, true)
  }

  // অন্যপক্ষ থেকে আসা কন্ট্রোল: actor-ই যাচাই করা প্রেরক
  const targetMid = (from: string, id: string, actor: string) => {
    const f = from.toLowerCase()
    return f === owner ? `${owner}|out|${id}` : f === actor.toLowerCase() ? `${owner}|in|${f}|${id}` : null
  }
  const applyControl = async (b: Body, actor: string, ts: number) => {
    const a = actor.toLowerCase()
    if (b.x) {
      const mid = targetMid(b.x.from, b.x.id, actor)
      if (mid) await apply(mid, cur => {
        if (cur.peer.toLowerCase() !== a || cur.deleted) return cur
        const r = { ...(cur.reactions ?? {}) }
        if (b.x!.e) r[a] = b.x!.e; else delete r[a]
        return { ...cur, reactions: r }
      })
    } else if (b.pn) {
      const mid = targetMid(b.pn.from, b.pn.id, actor)
      if (mid) await apply(mid, cur =>
        cur.peer.toLowerCase() !== a || cur.deleted ? cur : { ...cur, pinned: b.pn!.on ? ts : undefined })
    } else if (b.ed) { // শুধু প্রেরক নিজের টেক্সট মেসেজ এডিট করতে পারে, ২০ মিনিটের মধ্যে
      await apply(`${owner}|in|${a}|${b.ed.id}`, cur =>
        cur.file || cur.deleted || ts - cur.ts > EDIT_WINDOW + 5 * 60_000 ? cur : { ...cur, text: b.ed!.t, edited: true })
    } else if (b.dl) {
      await apply(`${owner}|in|${a}|${b.dl.id}`, cur => (cur.deleted ? cur : tomb(cur)))
    } else if (b.rn) {
      // কন্টাক্ট username বদলেছে। শুধু তখনই মানি যখন তার কী আগের নামের কী-র সঙ্গে হুবহু মেলে
      const old = b.rn.old.toLowerCase()
      const known = localStorage.getItem('pk:' + old)
      if (old === a || !known || !msgsRef.current.some(m => m.peer.toLowerCase() === old)) return
      const u = await lookupUser(actor, token).catch(() => null)
      if (!u?.publicKey || u.publicKey !== known) return
      await renamePeer(owner, old, actor)
      setMsgs(await loadMessages(username))
      if (activeRef.current?.toLowerCase() === old) {
        history.replaceState({ chat: actor }, '', '#c/' + encodeURIComponent(actor))
        setActive(actor)
      }
    }
  }

  useEffect(() => {
    const f = () => { if (document.visibilityState === 'visible' && activeRef.current) sendReads(activeRef.current) }
    document.addEventListener('visibilitychange', f)
    return () => document.removeEventListener('visibilitychange', f)
  }, [])

  // ব্যাক বাটন/সোয়াইপ: চ্যাট থেকে লিস্টে ফেরা (অ্যাপ থেকে বের হয় না)
  useEffect(() => {
    const c = fromHash()
    if (c && !history.state?.chat) { // সরাসরি লিংকে খুললে নিচে লিস্টের একটা এন্ট্রি বসাই
      history.replaceState(null, '', location.pathname + location.search)
      history.pushState({ chat: c }, '', '#c/' + encodeURIComponent(c))
    }
    const onPop = () => setActive(fromHash())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // রিফ্রেশের পর মেসেজ লোড হলে খোলা চ্যাটকে পড়া ধরা ও রিসিপ্ট পাঠানো
  useEffect(() => {
    if (!active || document.visibilityState !== 'visible') return
    const lastIn = msgs.filter(m => !m.mine && m.peer.toLowerCase() === active.toLowerCase())
      .reduce((t, m) => Math.max(t, m.ts), 0)
    markRead(active, lastIn)
    sendReads(active)
  }, [active, msgs.length])

  const rk = (p: string) => `read:${owner}:${p.toLowerCase()}`
  const readTs = (p: string) => reads[p.toLowerCase()] ?? Number(localStorage.getItem(rk(p)) || 0)
  const markRead = (p: string, upTo = 0) => {
    const v = Math.max(Date.now(), upTo)
    localStorage.setItem(rk(p), String(v))
    setReads(r => ({ ...r, [p.toLowerCase()]: v }))
  }

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3000)
    return () => clearTimeout(t)
  }, [toast])

  // ফাইল ডাউনলোড → ডিক্রিপ্ট → লোকাল সেভ → তারপর R2 থেকে মুছে ফেলা
  const downloadFile = async (m: StoredMsg) => {
    if (!m.file || m.blob || m.gone || dlBusy.current.has(m.mid)) return
    dlBusy.current.add(m.mid)
    setDl(d => ({ ...d, [m.mid]: 'loading' }))
    try {
      let encData = await downloadBlob(m.file.id, token)
      // KV-তে নতুন ফাইল অন্য লোকেশনে পৌঁছাতে কয়েক সেকেন্ড লাগতে পারে, তাই কয়েকবার চেষ্টা
      for (let i = 0; i < 3 && encData === null; i++) {
        await new Promise(r => setTimeout(r, 3000))
        encData = await downloadBlob(m.file.id, token)
      }
      const patch: Partial<StoredMsg> = encData === null
        ? { gone: true }
        : { blob: new Blob([await decryptFile(encData, m.file.k)], { type: safeType(m.file.m) }) }
      // একই ট্রানজাকশনে সেভ (এর মধ্যে আসা রিঅ্যাকশন/এডিট নষ্ট হবে না); মুছে ফেলা মেসেজে ফাইল বসে না
      const upd = await mutateMessage(m.mid, cur => (cur.deleted ? cur : { ...cur, ...patch }))
      if (upd) setMsgs(cur => cur.map(x => (x.mid === m.mid ? upd : x)))
      setDl(d => { const n = { ...d }; delete n[m.mid]; return n })
      if (upd?.blob) call('/api/media/' + m.file.id, 'DELETE', undefined, token).catch(() => {})
    } catch {
      setDl(d => ({ ...d, [m.mid]: 'error' }))
    } finally {
      dlBusy.current.delete(m.mid)
    }
  }

  const autoable = (m: StoredMsg) =>
    !m.mine && !!m.file && !m.blob && !m.gone && (isImg(m.file.m) || isAudio(m.file.m)) && m.file.s <= AUTO_MAX

  useEffect(() => {
    let alive = true
    loadMessages(username).then(stored => {
      if (!alive) return
      setLoaded(true)
      setMsgs(cur => mergeAll(cur, stored))
      stored.filter(autoable).forEach(m => void downloadFile(m))
    })
    conn.current = connect(token, {
      onStatus: setOnline,
      onError: setToast,
      onSent: id => void setStatus(`${owner}|out|${id}`, 'sent'),
      onMsg: async m => {
        const body = await decryptBody(identity, username, m.from, token, m.payload)
        if (body?.c) { // রিসিপ্ট: বাবল নয়, শুধু টিক আপডেট
          for (const id of body.c.ids)
            void setStatus(`${owner}|out|${id}`, body.c.k === 'r' ? 'read' : 'delivered', m.from)
          return true
        }
        if (body && (body.x || body.pn || body.ed || body.dl || body.rn)) { await applyControl(body, m.from, m.ts); return true }
        const mid = `${owner}|in|${m.from.toLowerCase()}|${m.id}`
        // একই মেসেজ আবার এলে পুরনোটা (ডাউনলোড করা ফাইলসহ) নষ্ট না করে শুধু ack
        if (await getMessage(mid)) return true
        const isActive = activeRef.current?.toLowerCase() === m.from.toLowerCase()
        const live = isActive && document.visibilityState === 'visible'
        const msg: StoredMsg = {
          mid, owner, peer: m.from, mine: false, ts: m.ts,
          text: body ? body.t ?? '' : 'ডিক্রিপ্ট করা যায়নি',
          failed: body === null, file: body?.f, rd: live, q: body?.q, fw: !!body?.fw,
        }
        await saveMessage(msg) // সেভ শেষ হলেই ack যাবে
        setMsgs(cur => mergeAll(cur, [msg]))
        if (isActive) markRead(m.from, m.ts)
        if (!live && soundOn()) beep() // অন্য চ্যাটে বা ব্যাকগ্রাউন্ডে মেসেজ এলে
        if (autoable(msg)) void downloadFile(msg)
        if (!msg.failed) {
          queueReceipt(m.from, 'd', m.id)
          if (live && readReceiptsOn()) queueReceipt(m.from, 'r', m.id)
        }
        return true
      },
    })
    return () => { alive = false; conn.current?.close() }
  }, [token])

  const convos = useMemo(() => {
    const map = new Map<string, { peer: string; last: StoredMsg; unread: number }>()
    for (const m of msgs) {
      const k = m.peer.toLowerCase()
      const c = map.get(k) ?? { peer: m.peer, last: m, unread: 0 }
      c.last = m
      if (!m.mine && m.ts > readTs(m.peer)) c.unread++
      map.set(k, c)
    }
    return [...map.values()].sort((a, b) => b.last.ts - a.last.ts)
  }, [msgs, reads])

  // ট্যাব টাইটেল ও হোম স্ক্রিন আইকনে আনরিড সংখ্যা
  const totalUnread = convos.reduce((n, c) => n + c.unread, 0)
  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) SecureChat` : 'SecureChat'
    const nav = navigator as any
    if (totalUnread) nav.setAppBadge?.(totalUnread)?.catch?.(() => {})
    else nav.clearAppBadge?.()?.catch?.(() => {})
  }, [totalUnread])
  useEffect(() => {
    void syncPush(token)
    return () => {
      document.title = 'SecureChat'
      ;(navigator as any).clearAppBadge?.()?.catch?.(() => {})
    }
  }, [token])

  const openChat = (peer: string) => {
    const lastIn = msgs.filter(m => !m.mine && m.peer.toLowerCase() === peer.toLowerCase())
      .reduce((t, m) => Math.max(t, m.ts), 0)
    markRead(peer, lastIn)
    const url = '#c/' + encodeURIComponent(peer)
    if (activeRef.current) history.replaceState({ chat: peer }, '', url) // বড় স্ক্রিনে চ্যাট বদল
    else history.pushState({ chat: peer }, '', url)
    setActive(peer)
    sendReads(peer)
  }
  const closeChat = () => {
    if (history.state?.chat) history.back() // popstate এসে active খালি করবে
    else { setActive(null); history.replaceState(null, '', location.pathname + location.search) }
  }

  const startChat = async () => {
    const n = newName.trim().replace(/^@/, '')
    if (!n) return
    if (n.toLowerCase() === owner) return setToast('নিজেকে মেসেজ পাঠানো যাবে না')
    try {
      const u = await lookupUser(n, token)
      if (!u.publicKey) return setToast('এই ইউজারের এনক্রিপশন কী নেই')
      setNewChat(false); setNewName(''); openChat(u.username)
    } catch { setToast('ইউজার পাওয়া যায়নি') }
  }

  // মেসেজ আগে সেভ (🕓), তারপর পাঠানো; সার্ভার নিলে ✓, প্রাপকের ডিভাইসে পৌঁছালে ✓✓, পড়লে নীল ✓✓
  const deliver = async (id: string, canon: string, payload: string, extra: Partial<StoredMsg>) => {
    const msg: StoredMsg = {
      mid: `${owner}|out|${id}`, owner, peer: canon, mine: true, text: '', ts: Date.now(),
      status: 'sending', ...extra,
    }
    await saveMessage(msg)
    setMsgs(cur => mergeAll(cur, [msg]))
    if (!conn.current?.send(canon, payload, id)) void setStatus(msg.mid, 'failed')
    return true
  }

  const sendText = async (peer: string, text: string, q?: Quote, fw?: boolean) => {
    if (!conn.current?.isOpen()) { setToast('কানেকশন নেই, একটু পরে চেষ্টা করুন'); return false }
    try {
      const body: Body = { t: text }
      if (q) body.q = q
      if (fw) body.fw = 1
      const { payload, peer: canon } = await encryptBody(identity, username, peer, token, body)
      return await deliver(crypto.randomUUID(), canon, payload, { text, q, fw })
    } catch (e: any) {
      setToast(e.message === 'Not found' ? 'ইউজার পাওয়া যায়নি' : e.message)
      return false
    }
  }

  const sendFile = async (peer: string, file: File, caption: string, dur?: number, q?: Quote, fw?: boolean) => {
    if (!fw && file.type.startsWith('image/')) file = await prepareImage(file) // ছোট করে JPEG
    if (file.size === 0) { setToast('ফাইলটা খালি'); return false }
    if (file.size > MAX_FILE) { setToast('ফাইল সর্বোচ্চ ২০ MB হতে পারবে'); return false }
    if (!conn.current?.isOpen()) { setToast('কানেকশন নেই, একটু পরে চেষ্টা করুন'); return false }
    let uploaded = ''
    let sent = false
    try {
      const u = await lookupUser(peer, token)
      if (!u.publicKey) throw new Error('এই ইউজারের এনক্রিপশন কী নেই')
      const [plain, th] = await Promise.all([file.arrayBuffer(), makeThumb(file)])
      const { data, k } = await encryptFile(plain)
      uploaded = await uploadBlob(u.username, data, token)

      const meta: FileMeta = {
        id: uploaded, k, n: file.name || 'file',
        m: file.type || 'application/octet-stream', s: file.size, th, d: dur,
      }
      const body: Body = { f: meta }
      if (caption) body.t = caption
      if (q) body.q = q
      if (fw) body.fw = 1
      let r = await encryptBody(identity, username, peer, token, body)
      if (r.payload.length > 90_000) { // মেসেজ বেশি বড় হলে থাম্বনেইল বাদ
        delete meta.th
        r = await encryptBody(identity, username, peer, token, body)
      }
      sent = true
      return await deliver(crypto.randomUUID(), r.peer, r.payload, {
        text: caption, file: meta, blob: new Blob([plain], { type: safeType(meta.m) }), q, fw,
      })
    } catch (e: any) {
      setToast(e.message === 'Not found' ? 'ইউজার পাওয়া যায়নি' : e.message)
      if (uploaded && !sent) call('/api/media/' + uploaded, 'DELETE', undefined, token).catch(() => {})
      return false
    }
  }

  return (
    <div className="h-dvh flex bg-slate-900 text-white">
      {/* ---- চ্যাট লিস্ট ---- */}
      <aside className={`${active ? 'hidden md:flex' : 'flex'} relative w-full md:w-80 flex-col border-r border-slate-800`}>
        <header className="flex items-center gap-2 p-3 border-b border-slate-800">
          <button onClick={() => setShowAccount(true)} title="অ্যাকাউন্ট"><Avatar name={username} src={myAvatar} /></button>
          <div className="flex-1 min-w-0">
            <p className="font-bold flex items-center gap-1"><Icon name="lock" className="size-4 text-emerald-400" /> SecureChat</p>
            <p className="text-xs text-slate-400">
              @{username} <span className={online ? 'text-emerald-400' : 'text-red-400'}><i className="inline-block size-2 rounded-full bg-current mr-1" />{online ? 'অনলাইন' : 'অফলাইন'}</span>
            </p>
          </div>
          <button onClick={() => setMenuOpen(o => !o)} className="size-9 grid place-items-center rounded-full text-slate-300 hover:bg-slate-800" title="মেনু">
            <Icon name="dots" className="size-6" />
          </button>
        </header>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-2 top-14 z-40 w-52 rounded-xl bg-slate-800 border border-slate-700 shadow-xl py-1">
              {([['account', 'user', 'অ্যাকাউন্ট'], ['privacy', 'lock', 'প্রাইভেসি'], ['settings', 'sliders', 'সেটিংস']] as const).map(([k, ic, label]) => (
                <button key={k} onClick={() => goMenu(k)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-700">
                  <Icon name={ic} className="size-5 text-slate-300" />{label}
                </button>
              ))}
              <div className="my-1 border-t border-slate-700" />
              <button onClick={() => goMenu('logout')} className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-red-300 hover:bg-slate-700">
                <Icon name="logout" className="size-5" />লগআউট
              </button>
            </div>
          </>
        )}
        <div className="flex-1 overflow-y-auto pb-24">
          {convos.length === 0 && (
            <p className="p-6 text-center text-slate-400 text-sm">কোনো চ্যাট নেই। উপরের + চেপে নতুন চ্যাট শুরু করুন।</p>
          )}
          {convos.map(c => (
            <button key={c.peer} onClick={() => openChat(c.peer)}
              className={`w-full flex gap-3 p-3 text-left hover:bg-slate-800 ${
                active?.toLowerCase() === c.peer.toLowerCase() ? 'bg-slate-800' : ''}`}>
              <PeerAvatar peer={c.peer} token={token} />
              <div className="flex-1 min-w-0">
                <div className="flex justify-between">
                  <span className="font-semibold truncate">@{c.peer}</span>
                  <span className="text-xs text-slate-400">{listTime(c.last.ts)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-sm text-slate-400 truncate">
                    {c.last.mine ? 'আপনি: ' : ''}{previewText(c.last)}
                  </span>
                  {c.unread > 0 && (
                    <span className="bg-emerald-600 text-xs rounded-full px-2 py-0.5 h-fit">{c.unread}</span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
        <button onClick={() => setNewChat(true)} title="নতুন চ্যাট"
          className="absolute bottom-6 right-5 z-10 size-14 rounded-full bg-emerald-600 shadow-lg shadow-black/40 grid place-items-center active:scale-95 transition-transform">
          <Icon name="plus" className="size-7" />
        </button>
      </aside>

      {/* ---- চ্যাট স্ক্রিন ---- */}
      <main className={`${active ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0`}>
        {active ? (
          <ChatView key={active} peer={active} session={session} dl={dl}
            list={msgs.filter(m => m.peer.toLowerCase() === active.toLowerCase())}
            onSend={sendText} onSendFile={sendFile} onDownload={downloadFile}
            act={{ react, pin, edit, del, forward }} peers={convos.map(c => c.peer)}
            onBack={closeChat} />
        ) : (
          <div className="flex-1 grid place-items-center text-slate-500">একটা চ্যাট বেছে নিন</div>
        )}
      </main>

      {newChat && (
        <div className="fixed inset-0 bg-black/60 grid place-items-center p-4" onClick={() => setNewChat(false)}>
          <div className="w-full max-w-sm bg-slate-800 rounded-xl p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <p className="font-semibold">নতুন চ্যাট</p>
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && startChat()} placeholder="username"
              className="w-full rounded-lg bg-slate-900 px-4 py-3 outline-none focus:ring-2 ring-emerald-500" />
            <button onClick={startChat} className="w-full rounded-lg bg-emerald-600 py-3 font-semibold">শুরু করুন</button>
          </div>
        </div>
      )}
      {showNotif && <NotifDialog token={token} onClose={() => setShowNotif(false)} />}
      {showAccount && (
        <AccountDialog session={session} avatar={myAvatar} onAvatar={changeAvatar} onClose={() => setShowAccount(false)}
          onName={f => onSession({ fullName: f })} onEmail={e => onSession({ email: e })} onUsername={changeUsername} />
      )}
      {showPrivacy && <PrivacyDialog identity={identity} onClearAll={clearAll} onClose={() => setShowPrivacy(false)} />}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-red-600 px-4 py-2 rounded-lg text-sm">{toast}</div>
      )}
    </div>
  )
}

function Voice({ url, dur }: { url: string; dur: number }) {
  const a = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const toggle = () => { const el = a.current; if (el) playing ? el.pause() : el.play().catch(() => {}) }
  return (
    <div className="flex items-center gap-2 min-w-52">
      <button onClick={toggle} className="size-9 shrink-0 rounded-full bg-white/20 grid place-items-center"><Icon name={playing ? 'pause' : 'play'} className="size-4" /></button>
      <div className="flex-1 h-1.5 rounded bg-white/20">
        <div className="h-full rounded bg-white" style={{ width: dur ? Math.min(100, (t / dur) * 100) + '%' : '0%' }} />
      </div>
      <span className="text-xs tabular-nums">{fmtDur(playing || t ? t : dur)}</span>
      <audio ref={a} src={url} preload="metadata"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setT(0) }}
        onTimeUpdate={e => setT(e.currentTarget.currentTime)} />
    </div>
  )
}

function Media({ m, state, onDownload }: {
  m: StoredMsg; state?: 'loading' | 'error'; onDownload: (m: StoredMsg) => void
}) {
  const f = m.file!
  const audio = isAudio(f.m)
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (!m.blob) return setUrl('')
    const u = URL.createObjectURL(m.blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [m.blob])

  return (
    <div className="space-y-1">
      {audio && url && <Voice url={url} dur={f.d ?? 0} />}
      {isImg(f.m) && (url
        ? <img src={url} alt={f.n} className="rounded-lg max-h-72 max-w-full" />
        : f.th && <img src={f.th} alt="" className="rounded-lg max-h-72 max-w-full blur-sm" />)}
      {!(audio && url) && (
        <p className="text-sm break-all">
          <span className="inline-flex items-center gap-1"><Icon name={audio ? 'mic' : 'file'} className="size-4 shrink-0" />{audio ? 'ভয়েস মেসেজ' : f.n}</span>{' '}
          <span className="text-white/60">· {audio ? fmtDur(f.d ?? 0) : fmtSize(f.s)}</span>
        </p>
      )}
      {m.blob ? (
        !audio && <a href={url} download={f.n} className="text-xs underline inline-flex items-center gap-1"><Icon name="download" className="size-3.5" /> সেভ করুন</a>
      ) : m.gone ? (
        <span className="text-xs text-red-300">ফাইলের মেয়াদ শেষ, আর পাওয়া যাবে না</span>
      ) : state === 'loading' ? (
        <span className="text-xs">ডাউনলোড হচ্ছে…</span>
      ) : (
        <button onClick={() => onDownload(m)} className="text-xs underline">
          <span className="inline-flex items-center gap-1"><Icon name="download" className="size-3.5" />{state === 'error' ? 'আবার চেষ্টা করুন' : 'ডাউনলোড'}</span>
        </button>
      )}
    </div>
  )
}

function ChatView({ peer, session, list, dl, act, peers, onSend, onSendFile, onDownload, onBack }: {
  peer: string; session: Session; list: StoredMsg[]; dl: DlState
  act: Actions; peers: string[]
  onSend: (peer: string, text: string, q?: Quote) => Promise<boolean>
  onSendFile: (peer: string, file: File, caption: string, dur?: number, q?: Quote) => Promise<boolean>
  onDownload: (m: StoredMsg) => void
  onBack: () => void
}) {
  const vk = `verified:${session.username.toLowerCase()}:${peer.toLowerCase()}`
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [safety, setSafety] = useState(false)
  const [keyChanged, setKeyChanged] = useState(false)
  const [verified, setVerified] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)
  const [rec, setRec] = useState(false)
  const [secs, setSecs] = useState(0)
  const mr = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const cancelled = useRef(false)
  const startedAt = useRef(0)
  const prof = useProfile(peer, session.token)
  const owner = session.username.toLowerCase()
  const [replyTo, setReplyTo] = useState<StoredMsg | null>(null)
  const [editing, setEditing] = useState<StoredMsg | null>(null)
  const [menu, setMenu] = useState<StoredMsg | null>(null)
  const [delAsk, setDelAsk] = useState<StoredMsg | null>(null)
  const [fwd, setFwd] = useState<StoredMsg | null>(null)
  const [pinIdx, setPinIdx] = useState(0)

  const makeQuote = (): Quote | undefined => replyTo && !replyTo.deleted
    ? { id: idOf(replyTo), from: replyTo.mine ? session.username : replyTo.peer, t: previewText(replyTo).slice(0, 120) }
    : undefined
  const qMid = (q: Quote) => q.from.toLowerCase() === owner
    ? `${owner}|out|${q.id}` : `${owner}|in|${q.from.toLowerCase()}|${q.id}`
  const canEdit = (m: StoredMsg) =>
    m.mine && !m.file && !m.deleted && !!m.text && Date.now() - m.ts < EDIT_WINDOW
  const jump = (mid: string) => {
    const idx = list.findIndex(m => m.mid === mid)
    if (idx < 0) return
    const go = () => {
      const el = document.getElementById('m-' + mid)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('bg-white/10')
      setTimeout(() => el.classList.remove('bg-white/10'), 1200)
    }
    const need = list.length - idx + 3 // পুরনো মেসেজে যেতে হলে আগে সেটা লোড করে নিই
    if (need > limit) { setLimit(need); setTimeout(go, 80) } else go()
  }
  const startReply = (m: StoredMsg) => { if (!m.deleted) { setEditing(null); setReplyTo(m) } }
  const doAct = (m: StoredMsg, k: string) => {
    if (k === 'reply') startReply(m)
    else if (k === 'copy') navigator.clipboard?.writeText(m.text).catch(() => {})
    else if (k === 'forward') setFwd(m)
    else if (k === 'pin') void act.pin(m)
    else if (k === 'edit') { setReplyTo(null); setEditing(m); setText(m.text) }
    else if (k === 'delete') { if (m.mine && !m.deleted) setDelAsk(m); else void act.del(m, false) }
  }
  const pins = list.filter(m => m.pinned).sort((a, b) => b.pinned! - a.pinned!)

  const stopRec = (cancel = false) => {
    cancelled.current = cancel
    if (mr.current?.state === 'recording') mr.current.stop()
  }
  const startRec = async () => {
    if (sending) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
      return alert('এই ব্রাউজারে ভয়েস রেকর্ড করা যাচ্ছে না')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t))
      const r = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined)
      chunks.current = []
      cancelled.current = false
      r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
      r.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        setRec(false)
        if (cancelled.current || !chunks.current.length) return
        const mime = (r.mimeType || type || 'audio/webm').split(';')[0]
        const dur = Math.max(1, Math.round((Date.now() - startedAt.current) / 1000))
        const file = new File([new Blob(chunks.current, { type: mime })],
          'voice.' + (mime.includes('mp4') ? 'm4a' : 'webm'), { type: mime })
        setSending(true)
        if (await onSendFile(peer, file, '', dur, makeQuote())) setReplyTo(null)
        setSending(false)
      }
      r.start()
      mr.current = r
      startedAt.current = Date.now()
      setSecs(0)
      setRec(true)
    } catch {
      alert('মাইক্রোফোনের অনুমতি দিন')
    }
  }
  useEffect(() => {
    if (!rec) return
    const t = setInterval(() => {
      const s = Math.round((Date.now() - startedAt.current) / 1000)
      setSecs(s)
      if (s >= 300) stopRec() // সর্বোচ্চ ৫ মিনিট
    }, 250)
    return () => clearInterval(t)
  }, [rec])
  useEffect(() => () => { cancelled.current = true; if (mr.current?.state === 'recording') mr.current.stop() }, [])

  // ---- স্ক্রোল: নিচে থাকলে নতুন মেসেজে নিচে যায়, উপরে পড়ার সময় জায়গায় থাকে ----
  const listRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const lastLen = useRef(0)
  const anchor = useRef<number | null>(null)
  const loadingRef = useRef(false)
  const [limit, setLimit] = useState(40) // প্রথমে শেষ ৪০টি দেখানো হয়, উপরে গেলে ৩০টি করে বাড়ে
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [showDown, setShowDown] = useState(false)
  const [below, setBelow] = useState(0)
  const hasMore = list.length > limit
  const shown = hasMore ? list.slice(list.length - limit) : list

  useLayoutEffect(() => {
    const last = list[list.length - 1]
    if (list.length > lastLen.current) {
      if (atBottom.current || last?.mine) {
        bottom.current?.scrollIntoView({ behavior: lastLen.current === 0 ? 'auto' : 'smooth' })
        setBelow(0)
      } else if (last && !last.mine) setBelow(n => n + list.length - lastLen.current)
    }
    lastLen.current = list.length
  }, [list.length])

  const loadOlder = () => {
    const el = listRef.current
    if (!el || loadingRef.current) return
    loadingRef.current = true
    setLoadingOlder(true)
    setTimeout(() => { anchor.current = el.scrollHeight; setLimit(l => l + 30) }, 250) // ধীরে ধীরে
  }
  useLayoutEffect(() => { // নতুন পুরনো মেসেজ উপরে বসলেও চোখের জায়গা একই থাকে
    const el = listRef.current
    if (anchor.current !== null && el) { el.scrollTop += el.scrollHeight - anchor.current; anchor.current = null }
    loadingRef.current = false
    setLoadingOlder(false)
  }, [limit])
  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    atBottom.current = dist < 120
    setShowDown(dist > 300)
    if (dist < 120) setBelow(0)
    if (el.scrollTop < 80 && hasMore) loadOlder()
  }

  useEffect(() => {
    lookupUser(peer, session.token).then(u => {
      const v = localStorage.getItem(vk)
      setVerified(!!v && v === u.publicKey)
      setKeyChanged(!!v && !!u.publicKey && v !== u.publicKey)
    }).catch(() => {})
  }, [])

  const submit = async () => {
    const t = text.trim()
    if (!t) return
    if (editing) { // এডিট মোড: নতুন মেসেজ নয়, আগেরটা বদলায়
      if (await act.edit(editing, t)) { setEditing(null); setText('') }
      return
    }
    if (await onSend(peer, t, makeQuote())) { setText(''); setReplyTo(null) }
  }

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f || sending) return
    setSending(true)
    if (await onSendFile(peer, f, text.trim(), undefined, makeQuote())) { setText(''); setReplyTo(null) } // লেখা থাকলে ক্যাপশন
    setSending(false)
  }

  return (
    <>
      <header className="flex items-center gap-3 p-3 border-b border-slate-800">
        <button onClick={onBack} className="md:hidden px-1 text-slate-300"><Icon name="back" className="size-6" /></button>
        <PeerAvatar peer={peer} token={session.token} />
        <div className="flex-1 min-w-0">
          <p className="font-semibold truncate">{prof?.fullName || '@' + peer}</p>
          <p className="text-xs text-slate-400 flex items-center gap-1">{prof ? '@' + peer + ' · ' : ''}{verified ? <><Icon name="shield" className="size-3.5 text-emerald-400" />ভেরিফাইড</> : <><Icon name="lock" className="size-3.5" />এন্ড-টু-এন্ড এনক্রিপ্টেড</>}</p>
        </div>
        <button onClick={() => setSafety(true)} className="text-sm text-emerald-400 px-2">নিরাপত্তা</button>
      </header>

      {keyChanged && (
        <div className="bg-red-900 text-sm p-3">
          <Icon name="alert" className="size-4 inline -mt-0.5" /> @{peer}-এর নিরাপত্তা কী বদলে গেছে। নতুন ডিভাইসে লগইন করলে এটা স্বাভাবিক, কিন্তু অন্য কারণও হতে পারে। "নিরাপত্তা" থেকে সেফটি নাম্বার মিলিয়ে নিন।
        </div>
      )}

      {pins.length > 0 && (
        <button onClick={() => { jump(pins[pinIdx % pins.length].mid); setPinIdx(i => i + 1) }}
          className="flex items-center gap-2 px-3 py-2 text-sm text-left bg-slate-800/70 border-b border-slate-800">
          <Icon name="pin" className="size-4 shrink-0" />
          <span className="flex-1 truncate text-slate-300">{previewText(pins[pinIdx % pins.length])}</span>
          {pins.length > 1 && <span className="text-xs text-slate-400">{(pinIdx % pins.length) + 1}/{pins.length}</span>}
        </button>
      )}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-3 space-y-1">
        {loadingOlder && <p className="text-center text-xs text-slate-500 py-2">পুরনো মেসেজ লোড হচ্ছে…</p>}
        {hasMore && !loadingOlder && (
          <button onClick={loadOlder} className="block mx-auto text-xs text-emerald-400 py-2">আরও পুরনো মেসেজ দেখুন</button>
        )}
        {list.length === 0 && (
          <p className="text-center text-xs text-slate-500 py-6">এখনো কোনো মেসেজ নেই। প্রথম মেসেজটা পাঠান।</p>
        )}
        {shown.map((m, i) => (
          <Fragment key={m.mid}>
            {(i === 0 || dayKey(shown[i - 1].ts) !== dayKey(m.ts)) && <DayChip ts={m.ts} />}
          <SwipeRow id={'m-' + m.mid} mine={m.mine}
            onReply={m.deleted ? undefined : () => startReply(m)} onMenu={() => setMenu(m)}>
            <div className={`rounded-2xl px-3 py-2 break-words space-y-1 ${
              m.failed ? 'bg-red-900' : m.mine ? 'bg-emerald-700' : 'bg-slate-700'} ${m.pinned ? 'ring-1 ring-amber-400/70' : ''}`}>
              {m.fw && <p className="text-[11px] text-white/60 italic flex items-center gap-1"><Icon name="forward" className="size-3" /> ফরওয়ার্ড করা</p>}
              {m.q && (
                <button onClick={() => jump(qMid(m.q!))}
                  className="block w-full text-left border-l-4 border-emerald-300 bg-black/20 rounded px-2 py-1">
                  <span className="block text-[11px] text-emerald-300">{m.q.from.toLowerCase() === owner ? 'আপনি' : '@' + m.q.from}</span>
                  <span className="block text-xs text-white/80 line-clamp-2">{m.q.t}</span>
                </button>
              )}
              {m.deleted ? (
                <p className="italic text-white/60 text-sm flex items-center gap-1.5"><Icon name="ban" className="size-4" /> মেসেজটি মুছে ফেলা হয়েছে</p>
              ) : (
                <>
                  {m.file && <Media m={m} state={dl[m.mid]} onDownload={onDownload} />}
                  {m.text && <p className="whitespace-pre-wrap">{m.text}</p>}
                </>
              )}
              <p className="text-[10px] text-white/60 text-right">
                {m.pinned && <Icon name="pin" className="size-3 inline mr-1 -mt-0.5" />}{m.edited && !m.deleted && 'এডিটেড · '}{hhmm(m.ts)}{m.mine && !m.deleted && <Tick s={m.status} />}
              </p>
            </div>
            {m.reactions && Object.keys(m.reactions).length > 0 && (
              <div className="-mt-2 mx-2 px-1.5 rounded-full bg-slate-800 border border-slate-600 text-xs w-fit">
                {Object.values(m.reactions).join('')}
              </div>
            )}
          </SwipeRow>
          </Fragment>
        ))}
        <div ref={bottom} />
      </div>
      {showDown && (
        <button onClick={() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); setBelow(0) }} title="নিচে যান"
          className="absolute bottom-3 right-3 size-11 rounded-full bg-slate-700 shadow-lg shadow-black/40 grid place-items-center active:scale-95 transition-transform">
          <Icon name="down" className="size-6" />
          {below > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 rounded-full bg-emerald-600 text-[11px] grid place-items-center">{below}</span>
          )}
        </button>
      )}
      </div>

      {(replyTo || editing) && (
        <div className="flex items-center gap-2 px-3 pt-2 border-t border-slate-800">
          <div className="flex-1 min-w-0 border-l-4 border-emerald-500 pl-2">
            <p className="text-xs text-emerald-400 flex items-center gap-1">
              <Icon name={editing ? 'edit' : 'reply'} className="size-3.5" />
              {editing ? 'মেসেজ এডিট করছেন' : 'উত্তর: ' + (replyTo!.mine ? 'আপনি' : prof?.fullName || '@' + peer)}
            </p>
            <p className="text-sm text-slate-300 truncate">{previewText((editing ?? replyTo)!)}</p>
          </div>
          <button onClick={() => { setReplyTo(null); if (editing) { setEditing(null); setText('') } }}
            className="text-slate-400 px-2"><Icon name="x" /></button>
        </div>
      )}
      {sending && <p className="px-4 pb-1 text-xs text-emerald-400">এনক্রিপ্ট করে পাঠানো হচ্ছে…</p>}
      {rec ? (
        <div className="flex items-center gap-3 p-3 border-t border-slate-800">
          <button onClick={() => stopRec(true)} className="size-12 shrink-0 rounded-full bg-slate-800 grid place-items-center"><Icon name="trash" /></button>
          <div className="flex-1 flex items-center gap-2 text-red-400">
            <span className="size-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="tabular-nums">{fmtDur(secs)}</span>
            <span className="text-xs text-slate-400">রেকর্ড হচ্ছে…</span>
          </div>
          <button onClick={() => stopRec()} className="size-12 shrink-0 rounded-full bg-emerald-600 grid place-items-center"><Icon name="send" /></button>
        </div>
      ) : (
        <div className="flex gap-2 p-3 border-t border-slate-800">
          <input ref={fileRef} type="file" className="hidden" onChange={pick} />
          <input ref={imgRef} type="file" accept="image/*" className="hidden" onChange={pick} />
          <button onClick={() => imgRef.current?.click()} disabled={sending} title="ছবি"
            className="size-11 shrink-0 rounded-full bg-slate-800 grid place-items-center text-slate-300 disabled:opacity-50"><Icon name="image" /></button>
          <button onClick={() => fileRef.current?.click()} disabled={sending} title="ফাইল"
            className="size-11 shrink-0 rounded-full bg-slate-800 grid place-items-center text-slate-300 disabled:opacity-50"><Icon name="clip" /></button>
          <input value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} placeholder="মেসেজ লিখুন"
            className="flex-1 min-w-0 rounded-full bg-slate-800 px-4 py-3 outline-none focus:ring-2 ring-emerald-500" />
          {text.trim()
            ? <button onClick={submit} className="size-12 shrink-0 rounded-full bg-emerald-600 grid place-items-center" title="পাঠান"><Icon name="send" /></button>
            : <button onClick={startRec} disabled={sending}
                className="size-12 shrink-0 rounded-full bg-emerald-600 grid place-items-center disabled:opacity-50" title="ভয়েস মেসেজ"><Icon name="mic" /></button>}
        </div>
      )}

      {menu && (
        <MsgMenu m={menu} canEdit={canEdit(menu)} myReaction={menu.reactions?.[owner]}
          onReact={e => { const m = menu; setMenu(null); void act.react(m, e) }}
          onAct={k => { const m = menu; setMenu(null); doAct(m, k) }} onClose={() => setMenu(null)} />
      )}
      {delAsk && (
        <Sheet onClose={() => setDelAsk(null)}>
          <p className="font-semibold">মেসেজ ডিলিট করবেন?</p>
          <button className="w-full rounded-lg bg-slate-700 py-3"
            onClick={() => { void act.del(delAsk, false); setDelAsk(null) }}>আমার থেকে মুছুন</button>
          <button className="w-full rounded-lg bg-red-700 py-3"
            onClick={() => { void act.del(delAsk, true); setDelAsk(null) }}>সবার থেকে মুছুন</button>
          <button className="w-full text-sm text-slate-400" onClick={() => setDelAsk(null)}>বাতিল</button>
        </Sheet>
      )}
      {fwd && (
        <ForwardDialog peers={peers.filter(p => p.toLowerCase() !== peer.toLowerCase())} token={session.token}
          onPick={async p => { if (await act.forward(fwd, p)) setFwd(null) }} onClose={() => setFwd(null)} />
      )}
      {safety && (
        <SafetyDialog peer={peer} session={session} vk={vk} onClose={ok => {
          setSafety(false)
          if (ok) { setVerified(true); setKeyChanged(false) }
        }} />
      )}
    </>
  )
}

function SafetyDialog({ peer, session, vk, onClose }: {
  peer: string; session: Session; vk: string; onClose: (verified?: boolean) => void
}) {
  const [num, setNum] = useState('')
  const [pub, setPub] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    lookupUser(peer, session.token).then(async u => {
      if (!u.publicKey) return setErr('এই ইউজারের কী নেই')
      setPub(u.publicKey)
      setNum(await safetyNumber(session.identity.publicKeyB64, u.publicKey))
    }).catch(() => setErr('লোড করা যায়নি'))
  }, [])

  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center p-4" onClick={() => onClose()}>
      <div className="w-full max-w-sm bg-slate-800 rounded-xl p-4 space-y-3" onClick={e => e.stopPropagation()}>
        <p className="font-semibold">@{peer}-এর সেফটি নাম্বার</p>
        <p className="text-sm text-slate-400">
          @{peer}-কে ফোন করে বা সামনাসামনি এই নাম্বার মিলিয়ে নিন। ওনার স্ক্রিনেও হুবহু একই নাম্বার দেখালে আপনাদের কথোপকথন সুরক্ষিত।
        </p>
        {err ? <p className="text-red-400 text-sm">{err}</p> : (
          <div className="grid grid-cols-3 gap-2 font-mono text-center text-emerald-400 bg-slate-900 rounded-lg p-3">
            {num.split(' ').map((g, i) => <span key={i}>{g}</span>)}
          </div>
        )}
        <button disabled={!pub} onClick={() => { localStorage.setItem(vk, pub); onClose(true) }}
          className="w-full rounded-lg bg-emerald-600 py-3 font-semibold disabled:opacity-50">
          মিলেছে, ভেরিফাইড মার্ক করুন
        </button>
        <button onClick={() => onClose()} className="w-full text-sm text-slate-400">বন্ধ করুন</button>
      </div>
    </div>
  )
}

function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center p-4 z-20" onClick={onClose}>
      <div className="w-full max-w-sm bg-slate-800 rounded-xl p-4 space-y-2" onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

// ডানে সোয়াইপ = রিপ্লাই; চেপে ধরা (বা ডেস্কটপে রাইট-ক্লিক) = মেনু
function SwipeRow({ id, mine, onReply, onMenu, children }: {
  id: string; mine: boolean; onReply?: () => void; onMenu: () => void; children: ReactNode
}) {
  const st = useRef({ x: 0, y: 0, moved: false })
  const timer = useRef(0)
  const [dx, setDx] = useState(0)
  const start = (e: TouchEvent) => {
    const t = e.touches[0]
    st.current = { x: t.clientX, y: t.clientY, moved: false }
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (!st.current.moved) { navigator.vibrate?.(15); onMenu() }
    }, 450)
  }
  const move = (e: TouchEvent) => {
    const t = e.touches[0]
    const ddx = t.clientX - st.current.x, ddy = t.clientY - st.current.y
    if (Math.abs(ddx) > 10 || Math.abs(ddy) > 10) { st.current.moved = true; clearTimeout(timer.current) }
    if (onReply && Math.abs(ddx) > Math.abs(ddy) * 1.5 && ddx > 0) setDx(Math.min(ddx, 72))
  }
  const end = () => {
    clearTimeout(timer.current)
    if (dx >= 56) onReply?.()
    setDx(0)
  }
  return (
    <div id={id} className={`relative flex rounded-lg transition-colors ${mine ? 'justify-end' : ''}`}
      onTouchStart={start} onTouchMove={move} onTouchEnd={end} onTouchCancel={end}
      onContextMenu={e => { e.preventDefault(); onMenu() }}>
      {dx > 16 && <span className="absolute left-2 top-1/2 -translate-y-1/2 text-emerald-400"><Icon name="reply" className="size-6" /></span>}
      <div className={`max-w-[80%] flex flex-col select-none [-webkit-touch-callout:none] ${mine ? 'items-end' : 'items-start'}`}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}>
        {children}
      </div>
    </div>
  )
}

function MsgMenu({ m, canEdit, myReaction, onReact, onAct, onClose }: {
  m: StoredMsg; canEdit: boolean; myReaction?: string
  onReact: (e: string) => void; onAct: (k: string) => void; onClose: () => void
}) {
  const rows: [string, IconName, string][] = []
  if (!m.deleted) rows.push(['reply', 'reply', 'উত্তর দিন'])
  if (!m.deleted && m.text) rows.push(['copy', 'copy', 'কপি'])
  if (!m.deleted) rows.push(['forward', 'forward', 'ফরওয়ার্ড'], ['pin', 'pin', m.pinned ? 'আনপিন' : 'পিন করুন'])
  if (canEdit) rows.push(['edit', 'edit', 'এডিট'])
  rows.push(['delete', 'trash', 'ডিলিট'])
  return (
    <Sheet onClose={onClose}>
      {!m.deleted && (
        <div className="flex justify-between pb-2">
          {REACTIONS.map(e => (
            <button key={e} onClick={() => onReact(e)}
              className={`size-11 rounded-full text-2xl ${myReaction === e ? 'bg-emerald-700' : 'bg-slate-700'}`}>{e}</button>
          ))}
        </div>
      )}
      {rows.map(([k, ic, label]) => (
        <button key={k} onClick={() => onAct(k)}
          className="w-full flex items-center gap-3 text-left rounded-lg bg-slate-700/60 px-4 py-3">
          <Icon name={ic} />{label}
        </button>
      ))}
    </Sheet>
  )
}

function ForwardDialog({ peers, token, onPick, onClose }: {
  peers: string[]; token: string; onPick: (peer: string) => Promise<void>; onClose: () => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const pick = async (p: string) => { if (busy || !p) return; setBusy(true); await onPick(p); setBusy(false) }
  return (
    <Sheet onClose={onClose}>
      <p className="font-semibold">ফরওয়ার্ড করুন</p>
      <div className="max-h-64 overflow-y-auto space-y-1">
        {peers.map(p => (
          <button key={p} disabled={busy} onClick={() => pick(p)}
            className="w-full flex items-center gap-3 rounded-lg bg-slate-700/60 px-3 py-2 text-left disabled:opacity-50">
            <PeerAvatar peer={p} token={token} /><span>@{p}</span>
          </button>
        ))}
        {peers.length === 0 && <p className="text-sm text-slate-400">অন্য কোনো চ্যাট নেই, নিচে username লিখুন।</p>}
      </div>
      <div className="flex gap-2 pt-1">
        <input value={name} onChange={e => setName(e.target.value.trim().replace(/^@/, ''))} placeholder="অন্য username"
          autoCapitalize="none" className="flex-1 min-w-0 rounded-lg bg-slate-900 px-3 py-2 outline-none" />
        <button disabled={busy || !name} onClick={() => pick(name)}
          className="rounded-lg bg-emerald-600 px-4 disabled:opacity-50">পাঠান</button>
      </div>
      <button onClick={onClose} className="w-full text-sm text-slate-400">বাতিল</button>
    </Sheet>
  )
}
