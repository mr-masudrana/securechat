import type { Identity } from './crypto'
export type Me = {
  id: string; username: string; fullName: string
  email: string | null; avatar: string | null; needsProfile: boolean
  bio: string; gender: string; birthDate: string
}
export type Session = {
  id: string; username: string; fullName: string; email: string | null; avatar: string | null
  bio: string; gender: string; birthDate: string
  token: string; identity: Identity
}
