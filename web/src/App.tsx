import { useEffect, useState } from 'react'
import { call } from './api'
import { ensureIdentity } from './crypto'
import { disablePush } from './push'
import { t } from './i18n'
import AuthScreen from './AuthScreen'
import ProfileSetup from './ProfileSetup'
import Messenger from './Messenger'
import type { Me, Session } from './types'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [pending, setPending] = useState<{ token: string; me: Me } | null>(null)
  const [boot, setBoot] = useState<'loading' | 'ready' | 'neterr'>('loading')

  const enter = async (token: string, me: Me) => {
    localStorage.setItem('token', token)
    if (me.needsProfile) { setPending({ token, me }); return }
    const identity = await ensureIdentity(me.id, me.username, token)
    setPending(null)
    setSession({ id: me.id, username: me.username, fullName: me.fullName, email: me.email, avatar: me.avatar,
      bio: me.bio, gender: me.gender, birthDate: me.birthDate, token, identity })
  }
  const safeEnter = (tok: string, m: Me) =>
    enter(tok, m).catch(() => alert(t('সংযোগে সমস্যা হয়েছে, আবার চেষ্টা করুন')))

  const start = async () => {
    setBoot('loading')
    const token = localStorage.getItem('token')
    if (token) {
      try {
        await enter(token, await call('/api/me', 'GET', undefined, token))
      } catch (e: any) {
        if (e.message !== 'Unauthorized') return setBoot('neterr') // নেটওয়ার্ক সমস্যা
        localStorage.removeItem('token')
      }
    }
    setBoot('ready')
  }
  useEffect(() => { start() }, [])

  const logout = async () => {
    const tok = session?.token ?? pending?.token
    localStorage.removeItem('token')
    setSession(null); setPending(null)
    history.replaceState(null, '', location.pathname + location.search) // খোলা চ্যাটের হ্যাশ মুছে ফেলা
    if (tok) {
      await disablePush(tok).catch(() => {}) // এই ডিভাইসে আর নোটিফিকেশন আসবে না
      call('/api/logout', 'POST', undefined, tok).catch(() => {})
    }
  }

  if (boot === 'loading')
    return <div className="min-h-dvh grid place-items-center bg-slate-900 text-slate-400">লোড হচ্ছে...</div>
  if (boot === 'neterr')
    return (
      <div className="min-h-dvh grid place-items-center bg-slate-900 text-white gap-3 p-4 text-center">
        <p>সার্ভারের সঙ্গে সংযোগ হচ্ছে না</p>
        <button onClick={start} className="rounded-lg bg-emerald-600 px-5 py-2">আবার চেষ্টা করুন</button>
      </div>
    )
  if (session) {
    // username বদলালে key বদলায়, ফলে Messenger নতুন নামে একদম নতুন করে চালু হয়
    return <Messenger key={session.username} session={session} onLogout={logout}
      onSession={p => setSession(s => (s ? { ...s, ...p } : s))} />
  }
  if (pending) return <ProfileSetup me={pending.me} token={pending.token} onDone={m => safeEnter(pending.token, m)} onLogout={logout} />
  return <AuthScreen onAuth={safeEnter} />
}
