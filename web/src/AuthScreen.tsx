import { useEffect, useState } from 'react'
import { call } from './api'
import type { Me } from './types'
import Icon from './Icon'

type Mode = 'login' | 'register' | 'verify' | 'forgot' | 'reset'
const TITLES: Record<Mode, string> = {
  login: 'লগইন করুন', register: 'নতুন অ্যাকাউন্ট খুলুন', verify: 'ইমেইল ভেরিফাই করুন',
  forgot: 'পাসওয়ার্ড ভুলে গেছেন?', reset: 'নতুন পাসওয়ার্ড দিন',
}

export default function AuthScreen({ onAuth }: { onAuth: (token: string, me: Me) => void }) {
  const [mode, setMode] = useState<Mode>('login')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [wait, setWait] = useState(0)

  useEffect(() => {
    if (wait <= 0) return
    const t = setTimeout(() => setWait(wait - 1), 1000)
    return () => clearTimeout(t)
  }, [wait])

  const go = (m: Mode) => { setMode(m); setError(''); setInfo('') }
  const run = async (fn: () => Promise<void>) => {
    setError(''); setInfo(''); setBusy(true)
    try { await fn() } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }
  const pwCheck = () => {
    if (password.length < 10) throw new Error('Password কমপক্ষে ১০ অক্ষর')
    if (password !== confirm) throw new Error('দুটো Password মিলছে না')
  }

  const submit = () => run(async () => {
    if (mode === 'login') {
      const r = await call('/api/login', 'POST', { identifier: email, password })
      onAuth(r.token, r.me)
    } else if (mode === 'register') {
      if (fullName.trim().length < 2) throw new Error('পুরো নাম লিখুন')
      pwCheck()
      await call('/api/register', 'POST', { fullName, email, password })
      setCode(''); setWait(60); setMode('verify')
      setInfo(`${email.trim()} ঠিকানায় ৬ সংখ্যার কোড পাঠানো হয়েছে। কিছুক্ষণের মধ্যে না এলে স্প্যাম ফোল্ডার দেখুন`)
    } else if (mode === 'verify') {
      const r = await call('/api/verify', 'POST', { email, code })
      onAuth(r.token, r.me)
    } else if (mode === 'forgot') {
      await call('/api/forgot', 'POST', { email })
      setCode(''); setPassword(''); setConfirm(''); setWait(60); setMode('reset')
      setInfo('ওই ইমেইলে অ্যাকাউন্ট থাকলে ৬ সংখ্যার কোড পাঠানো হয়েছে')
    } else {
      pwCheck()
      await call('/api/reset', 'POST', { email, code, password })
      setPassword(''); setConfirm(''); setCode('')
      go('login')
      setInfo('পাসওয়ার্ড বদলেছে, নতুন পাসওয়ার্ড দিয়ে লগইন করুন')
    }
  })

  const resend = () => run(async () => {
    await call('/api/resend', 'POST', { email, purpose: mode === 'reset' ? 'reset' : 'signup' })
    setWait(60); setInfo('নতুন কোড পাঠানো হয়েছে')
  })

  const input = 'w-full rounded-lg bg-slate-800 px-4 py-3 outline-none focus:ring-2 ring-emerald-500'
  const btn = mode === 'login' ? 'লগইন' : mode === 'register' ? 'কোড পাঠান' : mode === 'verify' ? 'ভেরিফাই করুন'
    : mode === 'forgot' ? 'কোড পাঠান' : 'পাসওয়ার্ড বদলান'
  const showEmail = mode !== 'verify' && mode !== 'reset'
  const showCode = mode === 'verify' || mode === 'reset'
  const showPw = mode === 'login' || mode === 'register' || mode === 'reset'
  const showConfirm = mode === 'register' || mode === 'reset'

  return (
    <div className="min-h-dvh grid place-items-center bg-slate-900 text-white p-4">
      <div className="w-full max-w-sm space-y-3">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Icon name="lock" className="size-6 text-emerald-400" /> SecureChat</h1>
        <p className="text-slate-400 text-sm">{TITLES[mode]}</p>
        {info && <p className="text-emerald-400 text-sm">{info}</p>}

        {mode === 'register' && (
          <input className={input} placeholder="পুরো নাম (Full name)" value={fullName}
            onChange={e => setFullName(e.target.value)} autoComplete="name" />
        )}
        {showEmail && (
          <input className={input} type={mode === 'login' ? 'text' : 'email'} autoCapitalize="none"
            placeholder={mode === 'login' ? 'ইমেইল বা username' : 'ইমেইল'} value={email}
            onChange={e => setEmail(e.target.value)} autoComplete={mode === 'login' ? 'username' : 'email'} />
        )}
        {showCode && (
          <input className={input + ' tracking-[0.5em] text-center text-xl'} inputMode="numeric" maxLength={6}
            placeholder="______" value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" />
        )}
        {showPw && (
          <input className={input} type="password"
            placeholder={mode === 'login' ? 'Password' : 'Password তৈরি করুন (কমপক্ষে ১০ অক্ষর)'}
            value={password} onChange={e => setPassword(e.target.value)}
            onKeyDown={e => mode === 'login' && e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        )}
        {showConfirm && (
          <input className={input} type="password" placeholder="Password আবার লিখুন" value={confirm}
            onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
        )}

        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button onClick={submit} disabled={busy}
          className="w-full rounded-lg bg-emerald-600 py-3 font-semibold disabled:opacity-50">
          {busy ? 'অপেক্ষা করুন...' : btn}
        </button>

        {showCode && (
          <button onClick={resend} disabled={busy || wait > 0} className="text-sm text-emerald-400 disabled:text-slate-500">
            {wait > 0 ? `আবার কোড পাঠান (${wait}s)` : 'আবার কোড পাঠান'}
          </button>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-400">
          {mode === 'login' && <>
            <button onClick={() => go('register')}>নতুন অ্যাকাউন্ট খুলুন</button>
            <button onClick={() => go('forgot')}>পাসওয়ার্ড ভুলে গেছেন?</button>
          </>}
          {mode === 'register' && <button onClick={() => go('verify')}>কোড পেয়েছেন? ভেরিফাই করুন</button>}
          {mode !== 'login' && (
            <button onClick={() => go('login')} className="flex items-center gap-1"><Icon name="back" className="size-4" /> লগইনে ফিরুন</button>
          )}
        </div>
      </div>
    </div>
  )
}
