import { useEffect, useState } from 'react'
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
