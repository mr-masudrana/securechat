import { useRef, useState, type ChangeEvent } from 'react'
import { call } from './api'
import { resizeAvatar } from './media'
import type { Me } from './types'
import Icon from './Icon'

export default function ProfileSetup({ me, token, onDone, onLogout }: {
  me: Me; token: string; onDone: (me: Me) => void; onLogout: () => void
}) {
  const [username, setUsername] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try { setAvatar(await resizeAvatar(f)) } catch { setError('ছবিটা পড়া যায়নি') }
  }

  const submit = async () => {
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
      return setError('Username ৩-২০ অক্ষর, শুধু ইংরেজি অক্ষর/সংখ্যা/_')
    setError(''); setBusy(true)
    try {
      onDone(await call('/api/profile', 'POST', { username, avatar }, token))
    } catch (e: any) {
      setError(e.message); setBusy(false)
    }
  }

  return (
    <div className="min-h-dvh grid place-items-center bg-slate-900 text-white p-4">
      <div className="w-full max-w-sm space-y-4 text-center">
        <h1 className="text-2xl font-bold">প্রোফাইল সম্পূর্ণ করুন</h1>
        <p className="text-slate-400 text-sm">স্বাগতম, {me.fullName}! একটা username বেছে নিন (পরে বদলানো যাবে না)।</p>
        <button onClick={() => fileRef.current?.click()}
          className="mx-auto size-28 rounded-full bg-slate-800 grid place-items-center overflow-hidden text-4xl">
          {avatar ? <img src={avatar} alt="" className="size-full object-cover" /> : <Icon name="camera" className="size-10 text-slate-400" />}
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pick} />
        <p className="text-xs text-slate-500">প্রোফাইল ছবি (ঐচ্ছিক, পরেও দেওয়া যাবে)</p>
        <input value={username} onChange={e => setUsername(e.target.value.trim())} placeholder="username"
          autoCapitalize="none" onKeyDown={e => e.key === 'Enter' && submit()}
          className="w-full rounded-lg bg-slate-800 px-4 py-3 outline-none focus:ring-2 ring-emerald-500" />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button onClick={submit} disabled={busy}
          className="w-full rounded-lg bg-emerald-600 py-3 font-semibold disabled:opacity-50">
          {busy ? 'অপেক্ষা করুন...' : 'চালিয়ে যান'}
        </button>
        <button onClick={onLogout} className="text-sm text-slate-400">লগআউট</button>
      </div>
    </div>
  )
}
