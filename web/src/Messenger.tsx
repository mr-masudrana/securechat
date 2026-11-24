import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { connect, type Conn } from './socket'
import { call, downloadBlob, uploadBlob } from './api'
import {
  decryptBody, decryptFile, encryptBody, encryptFile, getMessage, loadMessages, lookupUser,
  MAX_FILE, safetyNumber, saveMessage, type Body, type FileMeta, type StoredMsg,
} from './crypto'
import { fmtSize, isImg, makeThumb, previewText, safeType } from './media'
import type { Session } from './types'

const AUTO_MAX = 10 * 1024 * 1024
type DlState = Record<string, 'loading' | 'error'>

const mergeAll = (cur: StoredMsg[], add: StoredMsg[]) => {
  const ids = new Set(cur.map(x => x.mid))
  return [...cur, ...add.filter(x => !ids.has(x.mid))].sort((a, b) => a.ts - b.ts)
}
const hhmm = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const listTime = (ts: number) => {
  const d = new Date(ts)
  return d.toDateString() === new Date().toDateString()
    ? hhmm(ts) : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}
const Avatar = ({ name }: { name: string }) => (
  <div className="size-11 shrink-0 rounded-full bg-emerald-700 grid place-items-center font-bold uppercase">
    {name[0]}
  </div>
)

export default function Messenger({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const { username, token, identity } = session
  const owner = username.toLowerCase()
  const [msgs, setMsgs] = useState<StoredMsg[]>([])
  const [online, setOnline] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  const [reads, setReads] = useState<Record<string, number>>({})
  const [toast, setToast] = useState('')
  const [newChat, setNewChat] = useState(false)
  const [newName, setNewName] = useState('')
  const [dl, setDl] = useState<DlState>({})
  const dlBusy = useRef(new Set<string>())
  const conn = useRef<Conn | null>(null)
  const activeRef = useRef<string | null>(null)
  activeRef.current = active

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
      const encData = await downloadBlob(m.file.id, token)
      const upd: StoredMsg = encData === null
        ? { ...m, gone: true }
        : { ...m, blob: new Blob([await decryptFile(encData, m.file.k)], { type: safeType(m.file.m) }) }
      await saveMessage(upd) // সেভ নিশ্চিত হওয়ার পরেই মোছা
      setMsgs(cur => cur.map(x => (x.mid === m.mid ? upd : x)))
      setDl(d => { const n = { ...d }; delete n[m.mid]; return n })
      if (upd.blob) call('/api/media/' + m.file.id, 'DELETE', undefined, token).catch(() => {})
    } catch {
      setDl(d => ({ ...d, [m.mid]: 'error' }))
    } finally {
      dlBusy.current.delete(m.mid)
    }
  }

  const autoable = (m: StoredMsg) =>
    !m.mine && !!m.file && !m.blob && !m.gone && isImg(m.file.m) && m.file.s <= AUTO_MAX

  useEffect(() => {
    let alive = true
    loadMessages(username).then(stored => {
      if (!alive) return
      setMsgs(cur => mergeAll(cur, stored))
      stored.filter(autoable).forEach(m => void downloadFile(m))
    })
    conn.current = connect(token, {
      onStatus: setOnline,
      onError: setToast,
      onMsg: async m => {
        const mid = `${owner}|in|${m.from.toLowerCase()}|${m.id}`
        // একই মেসেজ আবার এলে পুরনোটা (ডাউনলোড করা ফাইলসহ) নষ্ট না করে শুধু ack
        if (await getMessage(mid)) return true
        const body = await decryptBody(identity, username, m.from, token, m.payload)
        const msg: StoredMsg = {
          mid, owner, peer: m.from, mine: false, ts: m.ts,
          text: body ? body.t ?? '' : '🔒 ডিক্রিপ্ট করা যায়নি',
          failed: body === null, file: body?.f,
        }
        await saveMessage(msg) // সেভ শেষ হলেই ack যাবে
        setMsgs(cur => mergeAll(cur, [msg]))
        if (activeRef.current?.toLowerCase() === m.from.toLowerCase()) markRead(m.from, m.ts)
        if (autoable(msg)) void downloadFile(msg)
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

  const openChat = (peer: string) => {
    const lastIn = msgs.filter(m => !m.mine && m.peer.toLowerCase() === peer.toLowerCase())
      .reduce((t, m) => Math.max(t, m.ts), 0)
    markRead(peer, lastIn)
    setActive(peer)
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

  const sendText = async (peer: string, text: string) => {
    try {
      const { payload, peer: canon } = await encryptBody(identity, username, peer, token, { t: text })
      const id = conn.current?.send(canon, payload)
      if (!id) return false
      const msg: StoredMsg = { mid: `${owner}|out|${id}`, owner, peer: canon, mine: true, text, ts: Date.now() }
      await saveMessage(msg)
      setMsgs(cur => mergeAll(cur, [msg]))
      return true
    } catch (e: any) {
      setToast(e.message === 'Not found' ? 'ইউজার পাওয়া যায়নি' : e.message)
      return false
    }
  }

  const sendFile = async (peer: string, file: File, caption: string) => {
    if (file.size === 0) { setToast('ফাইলটা খালি'); return false }
    if (file.size > MAX_FILE) { setToast('ফাইল সর্বোচ্চ ২৫ MB হতে পারবে'); return false }
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
        m: file.type || 'application/octet-stream', s: file.size, th,
      }
      const body: Body = { f: meta }
      if (caption) body.t = caption
      let r = await encryptBody(identity, username, peer, token, body)
      if (r.payload.length > 90_000) { // মেসেজ বেশি বড় হলে থাম্বনেইল বাদ
        delete meta.th
        r = await encryptBody(identity, username, peer, token, body)
      }
      const id = conn.current?.send(r.peer, r.payload)
      if (!id) throw new Error('কানেকশন নেই, আবার চেষ্টা করুন')
      sent = true

      const msg: StoredMsg = {
        mid: `${owner}|out|${id}`, owner, peer: r.peer, mine: true, text: caption, ts: Date.now(),
        file: meta, blob: new Blob([plain], { type: safeType(meta.m) }),
      }
      await saveMessage(msg)
      setMsgs(cur => mergeAll(cur, [msg]))
      return true
    } catch (e: any) {
      setToast(e.message === 'Not found' ? 'ইউজার পাওয়া যায়নি' : e.message)
      if (uploaded && !sent) call('/api/media/' + uploaded, 'DELETE', undefined, token).catch(() => {})
      return false
    }
  }

  return (
    <div className="h-dvh flex bg-slate-900 text-white">
      {/* ---- চ্যাট লিস্ট ---- */}
      <aside className={`${active ? 'hidden md:flex' : 'flex'} w-full md:w-80 flex-col border-r border-slate-800`}>
        <header className="flex items-center gap-2 p-3 border-b border-slate-800">
          <div className="flex-1">
            <p className="font-bold">🔒 SecureChat</p>
            <p className="text-xs text-slate-400">
              @{username} <span className={online ? 'text-emerald-400' : 'text-red-400'}>● {online ? 'অনলাইন' : 'অফলাইন'}</span>
            </p>
          </div>
          <button onClick={() => setNewChat(true)} className="size-9 rounded-full bg-emerald-600 text-xl">+</button>
          <button onClick={onLogout} className="text-xs text-slate-400 px-2">লগআউট</button>
        </header>
        <div className="flex-1 overflow-y-auto">
          {convos.length === 0 && (
            <p className="p-6 text-center text-slate-400 text-sm">কোনো চ্যাট নেই। উপরের + চেপে নতুন চ্যাট শুরু করুন।</p>
          )}
          {convos.map(c => (
            <button key={c.peer} onClick={() => openChat(c.peer)}
              className={`w-full flex gap-3 p-3 text-left hover:bg-slate-800 ${
                active?.toLowerCase() === c.peer.toLowerCase() ? 'bg-slate-800' : ''}`}>
              <Avatar name={c.peer} />
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
      </aside>

      {/* ---- চ্যাট স্ক্রিন ---- */}
      <main className={`${active ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0`}>
        {active ? (
          <ChatView key={active} peer={active} session={session} dl={dl}
            list={msgs.filter(m => m.peer.toLowerCase() === active.toLowerCase())}
            onSend={sendText} onSendFile={sendFile} onDownload={downloadFile}
            onBack={() => setActive(null)} />
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
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-red-600 px-4 py-2 rounded-lg text-sm">{toast}</div>
      )}
    </div>
  )
}

function Media({ m, state, onDownload }: {
  m: StoredMsg; state?: 'loading' | 'error'; onDownload: (m: StoredMsg) => void
}) {
  const f = m.file!
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (!m.blob) return setUrl('')
    const u = URL.createObjectURL(m.blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [m.blob])

  return (
    <div className="space-y-1">
      {isImg(f.m) && (url
        ? <img src={url} alt={f.n} className="rounded-lg max-h-72 max-w-full" />
        : f.th && <img src={f.th} alt="" className="rounded-lg max-h-72 max-w-full blur-sm" />)}
      <p className="text-sm break-all">📎 {f.n} <span className="text-white/60">· {fmtSize(f.s)}</span></p>
      {m.blob ? (
        <a href={url} download={f.n} className="text-xs underline">⬇ সেভ করুন</a>
      ) : m.gone ? (
        <span className="text-xs text-red-300">ফাইলের মেয়াদ শেষ, আর পাওয়া যাবে না</span>
      ) : state === 'loading' ? (
        <span className="text-xs">ডাউনলোড হচ্ছে…</span>
      ) : (
        <button onClick={() => onDownload(m)} className="text-xs underline">
          {state === 'error' ? 'আবার চেষ্টা করুন' : '⬇ ডাউনলোড'}
        </button>
      )}
    </div>
  )
}

function ChatView({ peer, session, list, dl, onSend, onSendFile, onDownload, onBack }: {
  peer: string; session: Session; list: StoredMsg[]; dl: DlState
  onSend: (peer: string, text: string) => Promise<boolean>
  onSendFile: (peer: string, file: File, caption: string) => Promise<boolean>
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

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }) }, [list.length])

  useEffect(() => {
    lookupUser(peer, session.token).then(u => {
      const v = localStorage.getItem(vk)
      setVerified(!!v && v === u.publicKey)
      setKeyChanged(!!v && !!u.publicKey && v !== u.publicKey)
    }).catch(() => {})
  }, [])

  const submit = async () => {
    const t = text.trim()
    if (t && (await onSend(peer, t))) setText('')
  }

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f || sending) return
    setSending(true)
    if (await onSendFile(peer, f, text.trim())) setText('') // লেখা থাকলে ক্যাপশন হিসেবে যায়
    setSending(false)
  }

  return (
    <>
      <header className="flex items-center gap-3 p-3 border-b border-slate-800">
        <button onClick={onBack} className="md:hidden text-2xl px-1">←</button>
        <Avatar name={peer} />
        <div className="flex-1 min-w-0">
          <p className="font-semibold truncate">@{peer}</p>
          <p className="text-xs text-slate-400">{verified ? '✅ ভেরিফাইড' : '🔒 এন্ড-টু-এন্ড এনক্রিপ্টেড'}</p>
        </div>
        <button onClick={() => setSafety(true)} className="text-sm text-emerald-400 px-2">নিরাপত্তা</button>
      </header>

      {keyChanged && (
        <div className="bg-red-900 text-sm p-3">
          ⚠️ @{peer}-এর নিরাপত্তা কী বদলে গেছে। নতুন ডিভাইসে লগইন করলে এটা স্বাভাবিক, কিন্তু অন্য কারণও হতে পারে। "নিরাপত্তা" থেকে সেফটি নাম্বার মিলিয়ে নিন।
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {list.length === 0 && (
          <p className="text-center text-xs text-slate-500 py-6">এখনো কোনো মেসেজ নেই। প্রথম মেসেজটা পাঠান।</p>
        )}
        {list.map(m => (
          <div key={m.mid} className={`flex ${m.mine ? 'justify-end' : ''}`}>
            <div className={`max-w-[80%] rounded-2xl px-3 py-2 break-words space-y-1 ${
              m.failed ? 'bg-red-900' : m.mine ? 'bg-emerald-700' : 'bg-slate-700'}`}>
              {m.file && <Media m={m} state={dl[m.mid]} onDownload={onDownload} />}
              {m.text && <p className="whitespace-pre-wrap">{m.text}</p>}
              <p className="text-[10px] text-white/60 text-right">{hhmm(m.ts)}</p>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {sending && <p className="px-4 pb-1 text-xs text-emerald-400">ফাইল এনক্রিপ্ট করে পাঠানো হচ্ছে…</p>}
      <div className="flex gap-2 p-3 border-t border-slate-800">
        <input ref={fileRef} type="file" className="hidden" onChange={pick} />
        <button onClick={() => fileRef.current?.click()} disabled={sending}
          className="size-12 shrink-0 rounded-full bg-slate-800 text-xl disabled:opacity-50">📎</button>
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} placeholder="মেসেজ লিখুন"
          className="flex-1 min-w-0 rounded-full bg-slate-800 px-4 py-3 outline-none focus:ring-2 ring-emerald-500" />
        <button onClick={submit} className="rounded-full bg-emerald-600 px-5 font-semibold">পাঠান</button>
      </div>

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
