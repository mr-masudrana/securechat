import { useEffect, useState } from 'react'
import { call } from './api'
import { lookupUser } from './crypto'

export type Profile = { fullName: string; avatar: string | null }
const cache = new Map<string, Profile>()

export function useProfile(name: string, token: string) {
  const k = name.toLowerCase()
  const [p, setP] = useState<Profile | undefined>(cache.get(k))
  useEffect(() => {
    let alive = true
    const hit = cache.get(k)
    if (hit) { setP(hit); return }
    lookupUser(name, token).then(u => {
      const v = { fullName: u.fullName || u.username, avatar: u.avatar ?? null }
      cache.set(k, v)
      if (alive) setP(v)
    }).catch(() => {})
    return () => { alive = false }
  }, [k])
  return p
}

// অন্যের অনলাইন স্ট্যাটাস: ৩০ সেকেন্ড পরপর (অ্যাপ সামনে থাকলে)। visible=false হলে মালিক দেখাতে দেননি
export type Presence = { visible: boolean; online?: boolean; lastSeen?: number | null }
export function usePresence(name: string, token: string) {
  const [p, setP] = useState<Presence | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => call('/api/presence/' + encodeURIComponent(name), 'GET', undefined, token)
      .then(r => { if (alive) setP(r) }).catch(() => {})
    load()
    const iv = window.setInterval(() => { if (document.visibilityState === 'visible') load() }, 30_000)
    const vis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', vis)
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', vis) }
  }, [name.toLowerCase(), token])
  return p
}
