import type { Identity } from './crypto'
export type Me = {
  id: string; username: string; fullName: string
  email: string | null; avatar: string | null; needsProfile: boolean
  bio: string; gender: string; birthDate: string
  genderVis: string; birthVis: string; onlineVis: string; hasCover: boolean
  publicKey?: string | null
}
export type Session = {
  id: string; username: string; fullName: string; email: string | null; avatar: string | null
  bio: string; gender: string; birthDate: string
  genderVis: string; birthVis: string; onlineVis: string; hasCover: boolean
  token: string; identity: Identity
}
