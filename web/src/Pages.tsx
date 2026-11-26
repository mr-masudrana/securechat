import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'
import { call } from './api'
import { resizeCover } from './media'
import { fingerprint, type Identity } from './crypto'
import { getLangPref, locale, raw, setLangPref, type Lang } from './i18n'
import { setReadReceipts, readReceiptsOn, setSound, soundOn } from './notify'
import { disablePush, enablePush, pushState, type PushState } from './push'
import { getThemePref, setThemePref, type Theme } from './theme'
import type { Session } from './types'

// ---------- সাধারণ অংশ ----------
export function PageShell({ title, onBack, right, children }: { title: string; onBack: () => void; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 bg-slate-900 text-white flex flex-col">
      <header className="flex items-center gap-2 p-3 border-b border-slate-800">
        <button onClick={onBack} className="size-9 grid place-items-center text-slate-300"><Icon name="back" className="size-6" /></button>
        <h1 className="flex-1 font-semibold text-lg">{title}</h1>
        {right}
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto w-full p-4 space-y-4">{children}</div>
      </div>
    </div>
  )
}
// ফুল স্ক্রিন ছবি: ছবিতে চাপলে জুম, বাইরে চাপলে/Esc/ব্যাক বাটনে বন্ধ
export function Lightbox({ src, name, onClose }: { src: string; name?: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(false)
  const close = () => { if (history.state?.viewer) history.back(); else onClose() }
  useEffect(() => {
    history.pushState({ ...(history.state ?? {}), viewer: true }, '', location.href)
    const pop = () => onClose()
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('popstate', pop)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('keydown', key) }
  }, [])
  const btn = { background: 'rgba(255,255,255,.18)', color: '#fff' }
  // body-তে রেন্ডার (সোয়াইপ-করা বাবলের transform fixed পজিশন নষ্ট না করে); ইভেন্ট নিচের বাবলে যেতে দেওয়া হয় না
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black flex items-center justify-center overflow-auto" style={{ color: '#fff' }}
      onClick={e => { e.stopPropagation(); close() }} onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop}
      onPointerDown={stop} onContextMenu={stop}>
      <div className="absolute top-0 inset-x-0 z-10 flex justify-end gap-2 p-3" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        {name && (
          <a href={src} download={name} onClick={e => e.stopPropagation()} style={btn} className="size-10 grid place-items-center rounded-full">
            <Icon name="download" className="size-5" />
          </a>
        )}
        <button onClick={e => { e.stopPropagation(); close() }} style={btn} className="size-10 grid place-items-center rounded-full" title="বন্ধ করুন">
          <Icon name="x" className="size-5" />
        </button>
      </div>
      <img src={src} alt="" draggable={false} onClick={e => { e.stopPropagation(); setZoom(z => !z) }}
        className={`max-h-full max-w-full object-contain transition-transform duration-200 ${zoom ? 'scale-200 cursor-zoom-out' : 'cursor-zoom-in'}`} />
    </div>,
    document.body,
  )
}
export const Card = ({ title, children }: { title?: string; children: ReactNode }) => (
  <section className="rounded-xl bg-slate-800 p-4 space-y-3">
    {title && <h2 className="text-sm font-semibold text-slate-300">{title}</h2>}
    {children}
  </section>
)
const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="py-2 border-b border-slate-700/60 last:border-0">
    <p className="text-xs text-slate-400">{label}</p>
    <p className="break-words whitespace-pre-wrap">{value}</p>
  </div>
)
const Inp = (p: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className="w-full rounded-lg bg-slate-900 px-4 py-3 outline-none focus:ring-2 ring-emerald-500" />
)
const Btn = ({ busy, onClick, children }: { busy?: boolean; onClick: () => void; children: ReactNode }) => (
  <button onClick={onClick} disabled={busy} className="w-full rounded-lg bg-emerald-600 py-3 font-semibold disabled:opacity-50">
    {busy ? 'অপেক্ষা করুন...' : children}
  </button>
)
function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center p-4 z-50" onClick={onClose}>
      <div className="w-full max-w-sm max-h-[90dvh] overflow-y-auto bg-slate-800 rounded-xl p-4 space-y-3" onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
function useRun() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const run = async (fn: () => Promise<void>) => {
    setErr(''); setBusy(true)
    try { await fn() } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return { busy, err, setErr, run }
}
const Err = ({ msg }: { msg: string }) => (msg ? <p className="text-sm text-red-400">{msg}</p> : null)
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} role="switch" aria-checked={on}
      className={`shrink-0 w-11 h-6 rounded-full p-0.5 transition-colors ${on ? 'bg-emerald-600' : 'bg-slate-600'}`}>
      <span className={`block size-5 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  )
}
function Choice<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="space-y-1">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)}
          className="w-full flex items-center justify-between rounded-lg bg-slate-700/60 px-4 py-3 text-left">
          <span>{label}</span>
          <span className={`size-5 rounded-full border-2 grid place-items-center ${value === v ? 'border-emerald-500' : 'border-slate-500'}`}>
            {value === v && <span className="size-2.5 rounded-full bg-emerald-500" />}
          </span>
        </button>
      ))}
    </div>
  )
}

// ---------- অ্যাকাউন্ট পেজ ----------
const GENDERS: [string, string][] = [['', 'বলতে চাই না'], ['male', 'পুরুষ'], ['female', 'নারী'], ['other', 'অন্যান্য']]
export const genderLabel = (g: string) => GENDERS.find(x => x[0] === g)?.[1] ?? 'বলতে চাই না'
export const fmtBirth = (d: string) => {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }) : '—'
}
const today = () => new Date().toISOString().slice(0, 10)

export function AccountPage({ session, avatar, onAvatar, onRemoveAvatar, onPatch, onUsername, onBack }: {
  session: Session; avatar: string | null; onAvatar: (e: ChangeEvent<HTMLInputElement>) => void
  onRemoveAvatar: () => void
  onPatch: (p: Partial<Session>) => void; onUsername: (name: string, current: string) => Promise<void>; onBack: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [d, setD] = useState({ name: '', bio: '', gender: '', birth: '' })
  const [ok, setOk] = useState('')
  const [uname, setUname] = useState(false)
  const [view, setView] = useState(false)
  const [cover, setCover] = useState<string | null>(null)
  const { busy, err, setErr, run } = useRun()
  useEffect(() => {
    if (!session.hasCover) { setCover(null); return }
    call('/api/cover/' + encodeURIComponent(session.username), 'GET', undefined, session.token)
      .then(r => setCover(r.cover ?? null)).catch(() => {})
  }, [session.hasCover])
  const pickCover = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    void run(async () => {
      const c = await resizeCover(f)
      await call('/api/profile/cover', 'POST', { cover: c }, session.token)
      setCover(c); onPatch({ hasCover: true }); setOk('কভার ফটো বদলেছে')
    })
  }
  const removeCover = () => run(async () => {
    await call('/api/profile/cover', 'POST', { cover: '' }, session.token)
    setCover(null); onPatch({ hasCover: false }); setOk('কভার ফটো সরানো হয়েছে')
  })

  const start = () => {
    setD({ name: session.fullName, bio: session.bio, gender: session.gender, birth: session.birthDate })
    setErr(''); setOk(''); setEditing(true)
  }
  const save = () => run(async () => {
    const r = await call('/api/account/profile', 'POST',
      { fullName: d.name, bio: d.bio, gender: d.gender, birthDate: d.birth }, session.token)
    onPatch({ fullName: r.fullName, bio: r.bio, gender: r.gender, birthDate: r.birthDate })
    setEditing(false); setOk('প্রোফাইল আপডেট হয়েছে')
  })

  const right = editing ? (
    <div className="flex items-center gap-1">
      <button onClick={() => setEditing(false)} className="px-2 text-slate-400">বাতিল</button>
      <button onClick={save} disabled={busy} className="px-3 py-1.5 rounded-lg bg-emerald-600 font-semibold disabled:opacity-50">সেভ</button>
    </div>
  ) : (
    <button onClick={start} className="flex items-center gap-1 px-2 text-emerald-400 font-medium">
      <Icon name="edit" className="size-4" /> ইডিট
    </button>
  )
  const pic = avatar
    ? <img src={avatar} alt="" className="size-28 rounded-full object-cover ring-4 ring-slate-900" />
    : <div className="size-28 rounded-full ring-4 ring-slate-900 bg-emerald-700 grid place-items-center text-4xl font-bold uppercase text-white">{session.username[0]}</div>

  return (
    <PageShell title="অ্যাকাউন্ট" onBack={onBack} right={right}>
      <div className="relative h-36 rounded-xl overflow-hidden bg-gradient-to-r from-emerald-800 to-slate-700">
        {cover && <img src={cover} alt="" className="size-full object-cover" />}
        {editing && (
          <div className="absolute bottom-2 right-2 flex gap-2">
            {cover && <button onClick={removeCover} disabled={busy} className="rounded-lg bg-black/60 px-3 py-1.5 text-sm text-red-300 disabled:opacity-50">সরান</button>}
            <label className="rounded-lg bg-black/60 px-3 py-1.5 text-sm cursor-pointer flex items-center gap-1">
              <Icon name="camera" className="size-4" /> কভার ফটো
              <input type="file" accept="image/*" className="hidden" onChange={pickCover} />
            </label>
          </div>
        )}
      </div>
      <div className="flex flex-col items-center gap-1 -mt-14 relative">
        {editing ? (
          <label className="relative cursor-pointer">
            {pic}
            <span className="absolute bottom-0 right-0 size-9 rounded-full bg-emerald-600 grid place-items-center border-2 border-slate-900 text-white">
              <Icon name="camera" className="size-4" />
            </span>
            <input type="file" accept="image/*" className="hidden" onChange={onAvatar} />
          </label>
        ) : avatar ? <button onClick={() => setView(true)}>{pic}</button> : pic}
        {editing && avatar && (
          <button onClick={onRemoveAvatar} className="text-sm text-red-400 pt-1">ছবি সরান</button>
        )}
        {!editing && (
          <>
            <p className="text-xl font-semibold pt-2">{raw(session.fullName)}</p>
            <p className="text-sm text-slate-400">@{session.username}</p>
          </>
        )}
      </div>
      {view && avatar && <Lightbox src={avatar} onClose={() => setView(false)} />}
      {ok && <p className="text-sm text-emerald-400 text-center">{ok}</p>}

      {!editing ? (
        <Card>
          <Row label="নাম" value={raw(session.fullName)} />
          <Row label="Username" value={'@' + session.username} />
          <Row label="Bio" value={session.bio ? raw(session.bio) : '—'} />
          <Row label="লিঙ্গ" value={genderLabel(session.gender)} />
          <Row label="জন্ম তারিখ" value={fmtBirth(session.birthDate)} />
        </Card>
      ) : (
        <Card>
          <label className="block space-y-1"><span className="text-xs text-slate-400">নাম</span>
            <Inp value={d.name} onChange={e => setD(x => ({ ...x, name: e.target.value }))} maxLength={60} /></label>
          <div className="space-y-1">
            <span className="text-xs text-slate-400">Username</span>
            <div className="flex items-center justify-between rounded-lg bg-slate-900 px-4 py-3">
              <span>@{session.username}</span>
              <button onClick={() => setUname(true)} className="text-sm text-emerald-400">বদলান</button>
            </div>
          </div>
          <label className="block space-y-1"><span className="text-xs text-slate-400">Bio</span>
            <textarea value={d.bio} onChange={e => setD(x => ({ ...x, bio: e.target.value }))} maxLength={150} rows={3}
              placeholder="নিজের সম্পর্কে কিছু লিখুন"
              className="w-full rounded-lg bg-slate-900 px-4 py-3 outline-none focus:ring-2 ring-emerald-500 resize-none" />
            <span className="block text-right text-xs text-slate-500">{d.bio.length}/150</span></label>
          <label className="block space-y-1"><span className="text-xs text-slate-400">লিঙ্গ</span>
            <select value={d.gender} onChange={e => setD(x => ({ ...x, gender: e.target.value }))}
              className="w-full rounded-lg bg-slate-900 px-4 py-3 outline-none focus:ring-2 ring-emerald-500">
              {GENDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
          <label className="block space-y-1"><span className="text-xs text-slate-400">জন্ম তারিখ</span>
            <Inp type="date" value={d.birth} min="1900-01-01" max={today()} onChange={e => setD(x => ({ ...x, birth: e.target.value }))} /></label>
          <Err msg={err} />
        </Card>
      )}
      <p className="text-xs text-slate-500 text-center">লিঙ্গ, জন্ম তারিখ ও অনলাইন স্ট্যাটাস কে দেখবে তা প্রাইভেসি পেজে ঠিক করুন। ইমেইল ও পাসওয়ার্ডও সেখানে বদলানো যায়।</p>
      {uname && <UsernameSheet onSubmit={onUsername} onClose={() => setUname(false)} />}
    </PageShell>
  )
}

function UsernameSheet({ onSubmit, onClose }: { onSubmit: (name: string, current: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('')
  const [cur, setCur] = useState('')
  const { busy, err, run } = useRun()
  return (
    <Modal onClose={onClose}>
      <p className="font-semibold">Username বদলান</p>
      <Inp value={name} onChange={e => setName(e.target.value)} placeholder="নতুন username" autoCapitalize="none" />
      <Inp type="password" value={cur} onChange={e => setCur(e.target.value)} placeholder="বর্তমান পাসওয়ার্ড" autoComplete="current-password" />
      <ul className="text-xs text-slate-400 space-y-1 list-disc pl-4">
        <li>৩-২০ অক্ষর, শুধু ইংরেজি অক্ষর, সংখ্যা ও _</li>
        <li>মাসে (৩০ দিনে) একবার বদলানো যায়।</li>
        <li>পুরনো username ৩০ দিন অন্য কেউ নিতে পারবে না।</li>
        <li>আপনার কন্টাক্টদের চ্যাট নিজে থেকে নতুন নামে সরে যাবে (তাদের অ্যাপ খুললে)।</li>
      </ul>
      <Err msg={err} />
      <Btn busy={busy} onClick={() => run(async () => { await onSubmit(name.trim(), cur) })}>Username বদলান</Btn>
      <button onClick={onClose} className="w-full text-sm text-slate-400">বাতিল</button>
    </Modal>
  )
}

// ---------- প্রাইভেসি পেজ (ইমেইল, পাসওয়ার্ড, প্রাইভেসি) ----------
function EmailForm({ token, onDone }: { token: string; onDone: (email: string) => void }) {
  const [step, setStep] = useState(1)
  const [email, setEmail] = useState('')
  const [cur, setCur] = useState('')
  const [code, setCode] = useState('')
  const { busy, err, run } = useRun()
  return step === 1 ? (
    <div className="space-y-3">
      <Inp type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="নতুন ইমেইল" autoCapitalize="none" />
      <Inp type="password" value={cur} onChange={e => setCur(e.target.value)} placeholder="বর্তমান পাসওয়ার্ড" autoComplete="current-password" />
      <p className="text-xs text-slate-500">নতুন ঠিকানায় একটা ৬ সংখ্যার কোড যাবে।</p>
      <Err msg={err} />
      <Btn busy={busy} onClick={() => run(async () => { await call('/api/account/email', 'POST', { email, current: cur }, token); setStep(2) })}>কোড পাঠান</Btn>
    </div>
  ) : (
    <div className="space-y-3">
      <p className="text-sm text-emerald-400">{email} ঠিকানায় কোড পাঠানো হয়েছে</p>
      <Inp value={code} inputMode="numeric" maxLength={6} placeholder="______" autoComplete="one-time-code"
        onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
      <Err msg={err} />
      <Btn busy={busy} onClick={() => run(async () => {
        const r = await call('/api/account/email/verify', 'POST', { email, code }, token)
        onDone(r.email)
      })}>ভেরিফাই করুন</Btn>
    </div>
  )
}

function PasswordForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const { busy, err, run } = useRun()
  return (
    <div className="space-y-3">
      <Inp type="password" value={cur} onChange={e => setCur(e.target.value)} placeholder="বর্তমান পাসওয়ার্ড" autoComplete="current-password" />
      <Inp type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="নতুন পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)" autoComplete="new-password" />
      <Inp type="password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="নতুন পাসওয়ার্ড আবার লিখুন" autoComplete="new-password" />
      <Err msg={err} />
      <Btn busy={busy} onClick={() => run(async () => {
        if (pw.length < 8) throw new Error('নতুন Password কমপক্ষে ৮ অক্ষর')
        if (pw !== pw2) throw new Error('দুটো Password মিলছে না')
        await call('/api/account/password', 'POST', { current: cur, password: pw }, token)
        onDone()
      })}>পাসওয়ার্ড বদলান</Btn>
    </div>
  )
}

export function PrivacyPage({ session, identity, onPatch, onClearAll, onDeleteAccount, onBack }: {
  session: Session; identity: Identity; onPatch: (p: Partial<Session>) => void
  onClearAll: () => Promise<void>; onDeleteAccount: (pw: string) => Promise<void>; onBack: () => void
}) {
  const [delOpen, setDelOpen] = useState(false)
  const [delPw, setDelPw] = useState('')
  const del = useRun()
  const [open, setOpen] = useState<'email' | 'password' | null>(null)
  const [ok, setOk] = useState('')
  const [rr, setRr] = useState(readReceiptsOn())
  const [fp, setFp] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { fingerprint(identity.publicKeyB64).then(setFp) }, [])
  const toggle = (k: 'email' | 'password') => { setOk(''); setOpen(o => (o === k ? null : k)) }

  return (
    <PageShell title="প্রাইভেসি" onBack={onBack}>
      {ok && <p className="text-sm text-emerald-400">{ok}</p>}
      <Card title="ইমেইল">
        <Row label="বর্তমান ইমেইল" value={session.email ?? 'যোগ করা নেই'} />
        <button onClick={() => toggle('email')} className="flex items-center gap-1 text-sm text-emerald-400">
          <Icon name="edit" className="size-4" /> ইমেইল বদলান
        </button>
        {open === 'email' && <EmailForm token={session.token} onDone={e => { onPatch({ email: e }); setOpen(null); setOk('ইমেইল বদলেছে') }} />}
      </Card>
      <Card title="পাসওয়ার্ড">
        <button onClick={() => toggle('password')} className="flex items-center gap-1 text-sm text-emerald-400">
          <Icon name="edit" className="size-4" /> পাসওয়ার্ড বদলান
        </button>
        {open === 'password' && <PasswordForm token={session.token} onDone={() => { setOpen(null); setOk('পাসওয়ার্ড বদলেছে, অন্য ডিভাইস লগআউট হয়ে গেছে') }} />}
      </Card>
      <VisibilityCard session={session} onPatch={onPatch} />
      <Card title="চ্যাট প্রাইভেসি">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>
            "পড়েছি" রিসিপ্ট পাঠান
            <span className="block text-xs text-slate-400">বন্ধ করলে অন্যরা আপনার মেসেজ পড়া নীল টিকে দেখবে না</span>
          </span>
          <Toggle on={rr} onChange={v => { setRr(v); setReadReceipts(v) }} />
        </div>
        <div className="rounded-lg bg-slate-900 p-3 space-y-1">
          <p className="text-xs text-slate-400">আপনার এনক্রিপশন কী-র ফিঙ্গারপ্রিন্ট</p>
          <p className="font-mono text-emerald-400 text-sm break-all">{fp || '…'}</p>
          <p className="text-xs text-slate-500">এই ডিভাইসের কী। ব্রাউজার ডেটা মুছলে বা অন্য ডিভাইসে লগইন করলে নতুন কী তৈরি হয়।</p>
        </div>
        <ul className="text-xs text-slate-400 space-y-1 list-disc pl-4">
          <li>মেসেজ ও ফাইল এন্ড-টু-এন্ড এনক্রিপ্টেড, সার্ভার পড়তে পারে না।</li>
          <li>পৌঁছানোর পর মেসেজ সার্ভার থেকে মুছে যায়, চ্যাট শুধু আপনার ডিভাইসে থাকে।</li>
          <li>নাম ও প্রোফাইল ছবি সার্ভারে সাধারণভাবে থাকে এবং লগইন করা সবাই দেখতে পারে।</li>
        </ul>
        {!confirm ? (
          <button onClick={() => setConfirm(true)} className="w-full flex items-center justify-center gap-2 rounded-lg bg-slate-700 py-3 text-red-400">
            <Icon name="trash" className="size-4" /> এই ডিভাইসের সব চ্যাট মুছুন
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-red-400">নিশ্চিত? এই ডিভাইসের সব মেসেজ ও ফাইল চিরতরে মুছে যাবে। অন্যের ডিভাইসে কিছু হবে না।</p>
            <button disabled={busy} onClick={async () => { setBusy(true); await onClearAll(); setBusy(false); setConfirm(false); setOk('এই ডিভাইসের সব চ্যাট মুছে গেছে') }}
              className="w-full rounded-lg bg-red-700 py-3 font-semibold disabled:opacity-50">হ্যাঁ, মুছে ফেলুন</button>
            <button onClick={() => setConfirm(false)} className="w-full text-sm text-slate-400">বাতিল</button>
          </div>
        )}
      </Card>
      <Card title="অ্যাকাউন্ট ডিলিট">
        {!delOpen ? (
          <button onClick={() => setDelOpen(true)} className="w-full rounded-lg bg-slate-700 py-3 text-red-400">অ্যাকাউন্ট চিরতরে মুছুন</button>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-red-400">অ্যাকাউন্ট, প্রোফাইল ও জমা থাকা মেসেজ সার্ভার থেকে মুছে যাবে এবং এই ডিভাইসের সব চ্যাট ও কী মুছবে। এটা ফেরানো যাবে না। আপনার username ৩০ দিন অন্য কেউ নিতে পারবে না।</p>
            <Inp type="password" value={delPw} onChange={e => setDelPw(e.target.value)} placeholder="বর্তমান পাসওয়ার্ড" autoComplete="current-password" />
            <Err msg={del.err} />
            <button disabled={del.busy || !delPw} onClick={() => del.run(async () => { await onDeleteAccount(delPw) })}
              className="w-full rounded-lg bg-red-700 py-3 font-semibold disabled:opacity-50">{del.busy ? 'অপেক্ষা করুন...' : 'হ্যাঁ, অ্যাকাউন্ট মুছুন'}</button>
            <button onClick={() => { setDelOpen(false); setDelPw('') }} className="w-full text-sm text-slate-400">বাতিল</button>
          </div>
        )}
      </Card>
    </PageShell>
  )
}

// ---------- কে কী দেখতে পারবে ----------
const VIS_OPTS: ['all' | 'contacts' | 'me', string][] = [['all', 'সবাই'], ['contacts', 'যাদের সঙ্গে চ্যাট করেছি'], ['me', 'শুধু আমি']]
function VisibilityCard({ session, onPatch }: { session: Session; onPatch: (p: Partial<Session>) => void }) {
  const [v, setV] = useState({ genderVis: session.genderVis, birthVis: session.birthVis, onlineVis: session.onlineVis })
  const [msg, setMsg] = useState('')
  const { err, run } = useRun()
  const change = (k: keyof typeof v, val: string) => {
    const next = { ...v, [k]: val }
    setV(next); setMsg('')
    void run(async () => {
      await call('/api/account/privacy', 'POST', next, session.token)
      onPatch(next); setMsg('সেটিং সেভ হয়েছে')
    })
  }
  const groups: [keyof typeof v, string][] = [['genderVis', 'কে আমার লিঙ্গ দেখতে পারবে'], ['birthVis', 'কে আমার জন্ম তারিখ দেখতে পারবে'], ['onlineVis', 'কে আমার অনলাইন স্ট্যাটাস দেখতে পারবে']]
  return (
    <Card title="প্রোফাইলের দৃশ্যমানতা">
      {groups.map(([k, label]) => (
        <div key={k} className="space-y-1">
          <p className="text-sm text-slate-300">{label}</p>
          <Choice value={v[k] as 'all' | 'contacts' | 'me'} options={VIS_OPTS} onChange={val => change(k, val)} />
        </div>
      ))}
      <p className="text-xs text-slate-500">"চ্যাট করেছি" মানে যাদের সঙ্গে আপনার মেসেজ আদান-প্রদান হয়েছে। নাম, ছবি, কভার ও bio সবসময় লগইন করা সবাই দেখতে পারে।</p>
      <Err msg={err} />
      {msg && <p className="text-sm text-emerald-400">{msg}</p>}
    </Card>
  )
}

// ---------- সেটিংস পেজ (পারমিশন, ভাষা, থিম) ----------
const MIC_TEXT: Record<string, string> = {
  granted: 'অনুমতি দেওয়া আছে', denied: 'ব্লক করা আছে', prompt: 'ব্যবহারের সময় জিজ্ঞেস করা হবে', unknown: 'অবস্থা জানা যায়নি',
}
export function SettingsPage({ token, onBack }: { token: string; onBack: () => void }) {
  const [mic, setMic] = useState('unknown')
  const [push, setPush] = useState<PushState | null>(null)
  const [sound, setSoundSt] = useState(soundOn())
  const [lang, setLang] = useState<Lang>(getLangPref())
  const [theme, setTheme] = useState<Theme>(getThemePref())
  const { busy, err, run } = useRun()

  const readMic = async () => {
    try { setMic((await (navigator as any).permissions.query({ name: 'microphone' })).state) } catch { setMic('unknown') }
  }
  useEffect(() => { void readMic(); pushState().then(setPush) }, [])

  const askMic = () => run(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach(t => t.stop())
    } catch { /* অনুমতি না দিলে নিচে অবস্থা দেখাবে */ }
    await readMic()
  })
  const togglePush = () => run(async () => {
    if (push === 'on') await disablePush(token)
    else await enablePush(token)
    setPush(await pushState())
  })

  return (
    <PageShell title="সেটিংস" onBack={onBack}>
      <Card title="পারমিশন">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2"><Icon name="mic" className="size-5" /> মাইক্রোফোন</span>
            {mic === 'granted'
              ? <span className="text-sm text-emerald-400">চালু</span>
              : mic !== 'denied' && <button onClick={askMic} disabled={busy} className="text-sm text-emerald-400">অনুমতি দিন</button>}
          </div>
          <p className="text-xs text-slate-400">{MIC_TEXT[mic] ?? MIC_TEXT.unknown}</p>
          {mic === 'denied' && <p className="text-xs text-amber-400">ব্রাউজার বা ফোনের সেটিংসে এই সাইটের মাইক্রোফোন অনুমতি চালু করুন।</p>}
        </div>
        <div className="space-y-1 pt-2 border-t border-slate-700/60">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2"><Icon name="bell" className="size-5" /> নোটিফিকেশন</span>
            {push === 'on' ? <Toggle on onChange={togglePush} />
              : (push === 'off') && <button onClick={togglePush} disabled={busy} className="text-sm text-emerald-400">অনুমতি দিন</button>}
          </div>
          <p className="text-xs text-slate-400">
            {push === 'on' ? 'চালু আছে' : push === 'denied' ? 'ব্লক করা আছে' : push === 'unsupported' ? 'এই ব্রাউজারে সাপোর্ট নেই' : push === 'off' ? 'বন্ধ আছে' : '…'}
          </p>
          {push === 'denied' && <p className="text-xs text-amber-400">ব্রাউজার বা ফোনের সেটিংসে এই সাইটের নোটিফিকেশন অনুমতি চালু করুন।</p>}
          {push === 'unsupported' && <p className="text-xs text-amber-400">iPhone-এ আগে Safari-র Share মেনু থেকে "Add to Home Screen" করে সেই অ্যাপ খুলুন।</p>}
        </div>
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-700/60 text-sm">
          <span>অ্যাপ খোলা থাকলে নতুন মেসেজের শব্দ</span>
          <Toggle on={sound} onChange={v => { setSoundSt(v); setSound(v) }} />
        </div>
        <Err msg={err} />
      </Card>

      <Card title="ভাষা">
        <Choice<Lang> value={lang} onChange={v => { setLangPref(v); setLang(v); location.reload() }}
          options={[['system', 'সিস্টেম ডিফল্ট'], ['en', 'English'], ['bn', 'বাংলা']]} />
        <p className="text-xs text-slate-500">ভাষা বদলালে অ্যাপ নিজে থেকে আবার লোড হবে।</p>
      </Card>

      <Card title="থিম">
        <Choice<Theme> value={theme} onChange={v => { setThemePref(v); setTheme(v) }}
          options={[['system', 'সিস্টেম ডিফল্ট'], ['dark', 'ডার্ক'], ['light', 'লাইট']]} />
      </Card>
    </PageShell>
  )
}
