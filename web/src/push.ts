import { call } from './api'

export type PushState = 'unsupported' | 'denied' | 'off' | 'on'
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

const toKey = (s: string) => {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const r = await navigator.serviceWorker.getRegistration()
  const sub = await r?.pushManager.getSubscription()
  return sub && Notification.permission === 'granted' ? 'on' : 'off'
}

export async function enablePush(token: string) {
  if (!supported()) throw new Error('এই ব্রাউজারে নোটিফিকেশন সাপোর্ট নেই')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('নোটিফিকেশনের অনুমতি দেওয়া হয়নি')
  if (!(await navigator.serviceWorker.getRegistration())) await navigator.serviceWorker.register('/sw.js')
  const r = await navigator.serviceWorker.ready
  const { key } = await call('/api/push/key', 'GET')
  const sub = (await r.pushManager.getSubscription())
    ?? (await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(key) }))
  await call('/api/push/subscribe', 'POST', { endpoint: sub.endpoint }, token)
}

export async function disablePush(token: string) {
  if (!supported()) return
  const r = await navigator.serviceWorker.getRegistration()
  const sub = await r?.pushManager.getSubscription()
  if (!sub) return
  await call('/api/push/unsubscribe', 'POST', { endpoint: sub.endpoint }, token).catch(() => {})
  await sub.unsubscribe().catch(() => {})
}

// লগইনের পর এই ডিভাইসের সাবস্ক্রিপশন বর্তমান ইউজারের সঙ্গে জুড়ে রাখে
export async function syncPush(token: string) {
  if ((await pushState()) !== 'on') return
  const r = await navigator.serviceWorker.getRegistration()
  const sub = await r?.pushManager.getSubscription()
  if (sub) await call('/api/push/subscribe', 'POST', { endpoint: sub.endpoint }, token).catch(() => {})
}
