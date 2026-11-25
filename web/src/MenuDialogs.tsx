import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react'
import Icon from './Icon'
import { call } from './api'
import { fingerprint, type Identity } from './crypto'
import { readReceiptsOn, setReadReceipts } from './notify'
import type { Session } from './types'

function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center p-4 z-50" onClick={onClose}>
      <div className="w-full max-w-sm max-h-[90dvh] overflow-y-auto bg-slate-800 rounded-xl p-4 space-y-3" onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-3 text-sm py-1.5 border-b border-slate-700/60">
    <span className="text-slate-400">{label}</span>
    <span className="text-right break-all">{value}</span>
  </div>
)

type View = 'main' | 'name' | 'username' | 'email' | 'password'
const Inp = (p: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className="w-full rounded-lg bg-slate-900 px-4 py-3 outline-none focus:ring-2 ring-emerald-500" />
)

export function AccountDialog({ session, avatar, onAvatar, onName, onEmail, onUsername, onClose }: {
  session: Session; avatar: string | null; onAvatar: (e: ChangeEvent<HTMLInputElement>) => void
  onName: (fullName: string) => void; onEmail: (email: string) => void
  onUsername: (name: string, current: string) => Promise<void>; onClose: () => void
}) {
  const [view, setView] = useState<View>('main')
  const [step, setStep] = useState(1)
  const [f, setF] = useState({ name: '', username: '', email: '', code: '', cur: '', pw: '', pw2: '' })
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => setF(x => ({ ...x, [k]: e.target.value }))
  const open = (v: View) => {
    setView(v); setStep(1); setErr(''); setOk('')
    setF({ name: session.fullName, username: '', email: '', code: '', cur: '', pw: '', pw2: '' })
  }
  const done = (msg: string) => { setView('main'); setOk(msg) }
  const run = async (fn: () => Promise<void>) => {
    setErr(''); setBusy(true)
    try { await fn() } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const t = session.token

  const saveName = () => run(async () => {
    const r = await call('/api/account/name', 'POST', { fullName: f.name }, t)
    onName(r.fullName); done('নাম বদলেছে')
  })
  const savePassword = () => run(async () => {
    if (f.pw.length < 8) throw new Error('নতুন Password কমপক্ষে ৮ অক্ষর')
    if (f.pw !== f.pw2) throw new Error('দুটো Password মিলছে না')
    await call('/api/account/password', 'POST', { current: f.cur, password: f.pw }, t)
    done('পাসওয়ার্ড বদলেছে, অন্য ডিভাইস লগআউট হয়ে গেছে')
  })
  const saveEmail = () => run(async () => {
    if (step === 1) {
      await call('/api/account/email', 'POST', { email: f.email, current: f.cur }, t)
      setStep(2)
    } else {
      const r = await call('/api/account/email/verify', 'POST', { email: f.email, code: f.code }, t)
      onEmail(r.email); done('ইমেইল বদলেছে')
    }
  })
  const saveUsername = () => run(async () => { await onUsername(f.username.trim(), f.cur) })

  const Back = () => (
    <button onClick={() => open('main')} className="flex items-center gap-1 text-sm text-slate-400">
      <Icon name="back" className="size-4" /> ফিরে যান
    </button>
  )
  const Save = ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick} disabled={busy} className="w-full rounded-lg bg-emerald-600 py-3 font-semibold disabled:opacity-50">
      {busy ? 'অপেক্ষা করুন...' : label}
    </button>
  )
  const Err = () => (err ? <p className="text-sm text-red-400">{err}</p> : null)

  if (view === 'name') return (
    <Modal onClose={onClose}>
      <Back /><p className="font-semibold">নাম বদলান</p>
      <Inp value={f.name} onChange={set('name')} placeholder="পুরো নাম" />
      <Err /><Save label="সেভ করুন" onClick={saveName} />
    </Modal>
  )
  if (view === 'password') return (
    <Modal onClose={onClose}>
      <Back /><p className="font-semibold">পাসওয়ার্ড বদলান</p>
      <Inp type="password" value={f.cur} onChange={set('cur')} placeholder="বর্তমান পাসওয়ার্ড" autoComplete="current-password" />
      <Inp type="password" value={f.pw} onChange={set('pw')} placeholder="নতুন পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)" autoComplete="new-password" />
      <Inp type="password" value={f.pw2} onChange={set('pw2')} placeholder="নতুন পাসওয়ার্ড আবার লিখুন" autoComplete="new-password" />
      <Err /><Save label="পাসওয়ার্ড বদলান" onClick={savePassword} />
    </Modal>
  )
  if (view === 'email') return (
    <Modal onClose={onClose}>
      <Back /><p className="font-semibold">ইমেইল বদলান</p>
      {step === 1 ? (
        <>
          <Inp type="email" value={f.email} onChange={set('email')} placeholder="নতুন ইমেইল" autoCapitalize="none" />
          <Inp type="password" value={f.cur} onChange={set('cur')} placeholder="বর্তমান পাসওয়ার্ড" autoComplete="current-password" />
          <p className="text-xs text-slate-500">নতুন ঠিকানায় একটা ৬ সংখ্যার কোড যাবে।</p>
          <Err /><Save label="কোড পাঠান" onClick={saveEmail} />
        </>
      ) : (
        <>
          <p className="text-sm text-emerald-400">{f.email} ঠিকানায় কোড পাঠানো হয়েছে</p>
          <Inp value={f.code} inputMode="numeric" maxLength={6} placeholder="______" autoComplete="one-time-code"
            onChange={e => setF(x => ({ ...x, code: e.target.value.replace(/\D/g, '') }))} />
          <Err /><Save label="ভেরিফাই করুন" onClick={saveEmail} />
        </>
      )}
    </Modal>
  )
  if (view === 'username') return (
    <Modal onClose={onClose}>
      <Back /><p className="font-semibold">Username বদলান</p>
      <Inp value={f.username} onChange={set('username')} placeholder="নতুন username" autoCapitalize="none" />
      <Inp type="password" value={f.cur} onChange={set('cur')} placeholder="বর্তমান পাসওয়ার্ড" autoComplete="current-password" />
      <ul className="text-xs text-slate-400 space-y-1 list-disc pl-4">
        <li>৩-২০ অক্ষর, শুধু ইংরেজি অক্ষর, সংখ্যা ও _</li>
        <li>মাসে (৩০ দিনে) একবার বদলানো যায়।</li>
        <li>পুরনো username ৩০ দিন অন্য কেউ নিতে পারবে না।</li>
        <li>আপনার কন্টাক্টদের চ্যাট নিজে থেকে নতুন নামে সরে যাবে (তাদের অ্যাপ খুললে)।</li>
      </ul>
      <Err /><Save label="Username বদলান" onClick={saveUsername} />
    </Modal>
  )

  const Item = ({ label, value, v }: { label: string; value: string; v: View }) => (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-slate-700/60">
      <div className="min-w-0">
        <p className="text-xs text-slate-400">{label}</p>
        <p className="text-sm break-all">{value}</p>
      </div>
      <button onClick={() => open(v)} className="shrink-0 flex items-center gap-1 text-sm text-emerald-400">
        <Icon name="edit" className="size-4" /> বদলান
      </button>
    </div>
  )
  return (
    <Modal onClose={onClose}>
      <p className="font-semibold flex items-center gap-2"><Icon name="user" /> অ্যাকাউন্ট</p>
      <div className="flex flex-col items-center gap-1 py-1">
        <label className="relative cursor-pointer">
          {avatar
            ? <img src={avatar} alt="" className="size-24 rounded-full object-cover" />
            : <div className="size-24 rounded-full bg-emerald-700 grid place-items-center text-3xl font-bold uppercase">{session.username[0]}</div>}
          <span className="absolute bottom-0 right-0 size-8 rounded-full bg-emerald-600 grid place-items-center border-2 border-slate-800">
            <Icon name="camera" className="size-4" />
          </span>
          <input type="file" accept="image/*" className="hidden" onChange={onAvatar} />
        </label>
        <p className="text-xs text-slate-500">ছবি বদলাতে ছবির ওপর চাপুন</p>
      </div>
      {ok && <p className="text-sm text-emerald-400">{ok}</p>}
      <div>
        <Item label="পুরো নাম" value={session.fullName} v="name" />
        <Item label="Username" value={'@' + session.username} v="username" />
        <Item label="ইমেইল" value={session.email ?? 'যোগ করা নেই'} v="email" />
        <Item label="পাসওয়ার্ড" value="••••••••" v="password" />
      </div>
      <button onClick={onClose} className="w-full text-sm text-slate-400">বন্ধ করুন</button>
    </Modal>
  )
}

export function PrivacyDialog({ identity, onClearAll, onClose }: {
  identity: Identity; onClearAll: () => Promise<void>; onClose: () => void
}) {
  const [rr, setRr] = useState(readReceiptsOn())
  const [fp, setFp] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { fingerprint(identity.publicKeyB64).then(setFp) }, [])

  return (
    <Modal onClose={onClose}>
      <p className="font-semibold flex items-center gap-2"><Icon name="lock" /> প্রাইভেসি</p>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          "পড়েছি" রিসিপ্ট পাঠান
          <span className="block text-xs text-slate-400">বন্ধ করলে অন্যরা আপনার মেসেজ পড়া নীল টিকে দেখবে না</span>
        </span>
        <input type="checkbox" checked={rr} className="size-5 accent-emerald-600 shrink-0"
          onChange={e => { setRr(e.target.checked); setReadReceipts(e.target.checked) }} />
      </label>

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
        <button onClick={() => setConfirm(true)}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-slate-700 py-3 text-red-300">
          <Icon name="trash" className="size-4" /> এই ডিভাইসের সব চ্যাট মুছুন
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-red-300">নিশ্চিত? এই ডিভাইসের সব মেসেজ ও ফাইল চিরতরে মুছে যাবে। অন্যের ডিভাইসে কিছু হবে না।</p>
          <button disabled={busy} onClick={async () => { setBusy(true); await onClearAll(); onClose() }}
            className="w-full rounded-lg bg-red-700 py-3 font-semibold disabled:opacity-50">হ্যাঁ, মুছে ফেলুন</button>
          <button onClick={() => setConfirm(false)} className="w-full text-sm text-slate-400">বাতিল</button>
        </div>
      )}
      <button onClick={onClose} className="w-full text-sm text-slate-400">বন্ধ করুন</button>
    </Modal>
  )
}
