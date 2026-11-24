import { useState } from 'react'
import { call } from './api'
import { generateIdentity, loadIdentity, saveIdentity } from './crypto'
import type { Session } from './types'

export default function AuthScreen({ onAuth }: { onAuth: (s: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setError(''); setBusy(true)
    try {
      let id, token, name
      if (mode === 'register') {
        id = await generateIdentity()
        const r = await call('/api/register', 'POST',
          { username, password, publicKey: id.publicKeyB64 })
        token = r.token; name = r.username
        await saveIdentity(name, id)
      } else {
        const r = await call('/api/login', 'POST', { username, password })
        token = r.token; name = r.username
        id = await loadIdentity(name)
        if (!id) {
          id = await generateIdentity()
          await call('/api/key', 'PUT', { publicKey: id.publicKeyB64 }, token)
          await saveIdentity(name, id)
        }
      }
      localStorage.setItem('token', token)
      onAuth({ username: name, token, identity: id })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const input = 'w-full rounded-lg bg-slate-800 px-4 py-3 outline-none focus:ring-2 ring-emerald-500'
  return (
    <div className="min-h-dvh grid place-items-center bg-slate-900 text-white p-4">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-bold">🔒 SecureChat</h1>
        <p className="text-slate-400 text-sm">{mode === 'register' ? 'নতুন অ্যাকাউন্ট খুলুন' : 'লগইন করুন'}</p>
        <input className={input} placeholder="username" value={username}
          onChange={e => setUsername(e.target.value)} />
        <input className={input} type="password" placeholder="password (কমপক্ষে ৮ অক্ষর)"
          value={password} onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button onClick={submit} disabled={busy}
          className="w-full rounded-lg bg-emerald-600 py-3 font-semibold disabled:opacity-50">
          {busy ? 'অপেক্ষা করুন...' : mode === 'register' ? 'রেজিস্টার' : 'লগইন'}
        </button>
        <button className="text-sm text-slate-400"
          onClick={() => setMode(mode === 'register' ? 'login' : 'register')}>
          {mode === 'register' ? 'আগেই অ্যাকাউন্ট আছে? লগইন' : 'নতুন অ্যাকাউন্ট খুলুন'}
        </button>
      </div>
    </div>
  )
}
