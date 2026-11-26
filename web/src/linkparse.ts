// মেসেজের লেখা থেকে লিংক, সোশ্যাল মিডিয়া/YouTube কার্ড ও @username আলাদা করে (শুধু যুক্তি, UI নেই)

export type Card =
  | { kind: 'yt'; id: string; start: number; href: string }
  | { kind: 'social'; label: string; color: string; href: string; shown: string }

export type Seg =
  | { t: 'text'; s: string }
  | { t: 'mention'; name: string }
  | { t: 'link'; shown: string; href: string; suspicious: boolean; card?: Card }

const SOCIAL: [string[], string, string][] = [
  [['facebook.com', 'fb.com', 'fb.watch'], 'Facebook', '#1877F2'],
  [['instagram.com'], 'Instagram', '#C13584'],
  [['x.com', 'twitter.com'], 'X', '#111111'],
  [['tiktok.com'], 'TikTok', '#111111'],
  [['t.me', 'telegram.me'], 'Telegram', '#229ED9'],
  [['wa.me', 'whatsapp.com'], 'WhatsApp', '#1FA855'],
  [['linkedin.com'], 'LinkedIn', '#0A66C2'],
  [['github.com'], 'GitHub', '#24292F'],
  [['reddit.com'], 'Reddit', '#FF4500'],
  [['pinterest.com'], 'Pinterest', '#E60023'],
  [['threads.net'], 'Threads', '#111111'],
  [['snapchat.com'], 'Snapchat', '#B8A800'],
  [['discord.gg', 'discord.com'], 'Discord', '#5865F2'],
  [['youtube.com', 'youtu.be'], 'YouTube', '#DC2626'], // ভিডিও আইডি না পেলে (চ্যানেল/প্লেলিস্ট) সাধারণ কার্ড
]
const KNOWN = SOCIAL.flatMap(x => x[0])
const KNOWN_RE = KNOWN.map(d => d.replace(/\./g, '\\.')).join('|')
const NOT_URL = `\\s<>"'\\u0980-\\u09FF` // স্পেস, কোটেশন ও বাংলা অক্ষরে লিংক থামে
// 1: আগের অক্ষর (শব্দের মাঝখানে মিললে বাদ), 2: স্কিমওয়ালা/www লিংক | পরিচিত ডোমেইন + পাথ | @mention
const RE = new RegExp(
  `(^|[^\\w@/.-])((?:https?:\\/\\/|www\\.)[^${NOT_URL}]+|(?:[a-z0-9-]+\\.)*(?:${KNOWN_RE})\\/[^${NOT_URL}]*|@[A-Za-z0-9_]{3,20}(?![\\w@]))`, 'gi')

const isHost = (host: string, d: string) => host === d || host.endsWith('.' + d)

function seconds(v: string | null): number {
  if (!v) return 0
  if (/^\d+$/.test(v)) return Math.min(+v, 86400 * 2)
  const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i)
  return m ? Math.min((+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + +(m[3] ?? 0), 86400 * 2) : 0
}

export function parseLink(tok: string): { href: string; host: string; suspicious: boolean; card?: Card } | null {
  let u: URL
  try { u = new URL(/^https?:\/\//i.test(tok) ? tok : 'https://' + tok) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null // https://facebook.com@evil.com ধরনের ছদ্মবেশ ঠেকাতে
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!/^[a-z0-9.-]+\.([a-z]{2,}|xn--[a-z0-9-]+)$/.test(host)) return null
  const suspicious = host.split('.').some(p => p.startsWith('xn--')) // অস্বাভাবিক (IDN) অক্ষরের ডোমেইন

  let card: Card | undefined
  let id: string | null | undefined
  if (isHost(host, 'youtu.be')) id = u.pathname.slice(1).split('/')[0]
  else if (isHost(host, 'youtube.com')) {
    id = u.pathname === '/watch' ? u.searchParams.get('v') : u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)?.[1]
  }
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
    card = { kind: 'yt', id, start: seconds(u.searchParams.get('t') ?? u.searchParams.get('start')), href: u.href }
  } else {
    const s = SOCIAL.find(x => x[0].some(d => isHost(host, d)))
    if (s) {
      const path = (u.pathname + u.search).replace(/\/$/, '')
      const shown = (host.replace(/^www\./, '') + path)
      card = { kind: 'social', label: s[1], color: s[2], href: u.href, shown: shown.length > 48 ? shown.slice(0, 47) + '…' : shown }
    }
  }
  return { href: u.href, host, suspicious, card }
}

const TAIL = /[.,!?;:'"\]}।)]$/
export function tokenize(text: string): Seg[] {
  const out: Seg[] = []
  let last = 0
  const text_ = (s: string) => { if (s) out.push({ t: 'text', s }) }
  for (const m of text.matchAll(RE)) {
    const start = (m.index ?? 0) + m[1].length
    const full = m[2]
    text_(text.slice(last, start))
    last = start + full.length
    if (full[0] === '@') { out.push({ t: 'mention', name: full.slice(1) }); continue }
    let tok = full
    while (TAIL.test(tok)) { // শেষের বিরামচিহ্ন লিংকের অংশ নয় (ভারসাম্যের ')' ছাড়া)
      if (tok.endsWith(')') && (tok.match(/\(/g)?.length ?? 0) >= (tok.match(/\)/g)?.length ?? 0)) break
      tok = tok.slice(0, -1)
    }
    const info = parseLink(tok)
    if (!info) { text_(full); continue }
    out.push({ t: 'link', shown: tok, href: info.href, suspicious: info.suspicious, card: info.card })
    text_(full.slice(tok.length))
  }
  text_(text.slice(last))
  return out
}
