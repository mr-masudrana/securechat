import { useEffect, useState } from 'react'
import { disablePush, enablePush, pushState, type PushState } from './push'
import { setSound, soundOn } from './notify'

export default function NotifDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const [st, setSt] = useState<PushState | null>(null)
  const [sound, setSoundState] = useState(soundOn())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { pushState().then(setSt) }, [])

  const toggle = async () => {
    setBusy(true); setErr('')
    try {
      if (st === 'on') await disablePush(token)
      else await enablePush(token)
    } catch (e: any) { setErr(e.message) }
    setSt(await pushState())
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center p-4" onClick={onClose}>
      <div className="w-full max-w-sm bg-slate-800 rounded-xl p-4 space-y-3" onClick={e => e.stopPropagation()}>
        <p className="font-semibold">🔔 নোটিফিকেশন</p>
        <p className="text-sm text-slate-400">
          অ্যাপ বন্ধ বা ব্যাকগ্রাউন্ডে থাকলে "নতুন মেসেজ এসেছে" জানানো হয়। এন্ড-টু-এন্ড এনক্রিপশনের কারণে নোটিফিকেশনে প্রেরকের নাম বা মেসেজ দেখায় না।
        </p>
        {st === null ? <p className="text-sm text-slate-500">দেখা হচ্ছে…</p>
          : st === 'unsupported' ? (
            <p className="text-sm text-amber-400">এই ব্রাউজারে সাপোর্ট নেই। iPhone-এ আগে Safari-র Share মেনু থেকে "Add to Home Screen" করে সেই অ্যাপ খুলুন।</p>
          ) : st === 'denied' ? (
            <p className="text-sm text-amber-400">নোটিফিকেশন ব্লক করা আছে। ব্রাউজারের সাইট সেটিংসে অনুমতি দিন, তারপর আবার চেষ্টা করুন।</p>
          ) : (
            <button onClick={toggle} disabled={busy}
              className={`w-full rounded-lg py-3 font-semibold disabled:opacity-50 ${st === 'on' ? 'bg-slate-700' : 'bg-emerald-600'}`}>
              {busy ? 'অপেক্ষা করুন...' : st === 'on' ? '✅ চালু আছে (বন্ধ করুন)' : 'নোটিফিকেশন চালু করুন'}
            </button>
          )}
        {err && <p className="text-red-400 text-sm">{err}</p>}
        <label className="flex items-center justify-between text-sm pt-1">
          <span>অ্যাপ খোলা থাকলে নতুন মেসেজের শব্দ</span>
          <input type="checkbox" checked={sound} className="size-5 accent-emerald-600"
            onChange={e => { setSoundState(e.target.checked); setSound(e.target.checked) }} />
        </label>
        <button onClick={onClose} className="w-full text-sm text-slate-400">বন্ধ করুন</button>
      </div>
    </div>
  )
}
