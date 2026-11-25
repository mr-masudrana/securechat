import type { Identity } from './crypto'
export type Me = {
  id: string; username: string; fullName: string
  email: string | null; avatar: string | null; needsProfile: boolean
}
export type Session = {
  id: string; username: string; fullName: string; email: string | null; avatar: string | null
  token: string; identity: Identity
}
