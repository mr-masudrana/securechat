import { useEffect, useState } from 'react'
import { call } from './api'
import { loadIdentity } from './crypto'
import AuthScreen from './AuthScreen'
import Messenger from './Messenger'
import type { Session } from './types'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [boot, setBoot] = useState<'loading' | 'ready' | 'neterr'>('loading')

  const start = async () => {
    setBoot('loading')
    const token = localStorage.getItem('token')
    if (token) {
      try {
        const me = await call('/api/me', 'GET', undefined, token)
        const identity = await loadIdentity(me.username)
        if (identity) setSession({ username: me.username, token, identity })
        else localStorage.removeItem('token') // এই ব্রাউজারে কী নেই, আবার লগইন লাগবে
      } catch (e: any) {
        if (e.message !== 'Unauthorized') return setBoot('neterr') // নেটওয়ার্ক সমস্যা
        localStorage.removeItem('token')
      }
    }
    setBoot('ready')
  }
  useEffect(() => { start() }, [])

  const logout = async () => {
    const t = session?.token
    localStorage.removeItem('token')
    setSession(null)
    if (t) call('/api/logout', 'POST', undefined, t).catch(() => {})
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
  return session
    ? <Messenger session={session} onLogout={logout} />
    : <AuthScreen onAuth={setSession} />
}
