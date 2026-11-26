import { EN, PATTERNS } from './en'

export type Lang = 'system' | 'en' | 'bn'
export const getLangPref = (): Lang => {
  const v = localStorage.getItem('pref:lang')
  return v === 'en' || v === 'system' ? v : 'bn'
}
export const setLangPref = (l: Lang) => localStorage.setItem('pref:lang', l)

const resolve = (): 'en' | 'bn' => {
  const p = getLangPref()
  if (p !== 'system') return p
  return (navigator.language || '').toLowerCase().startsWith('bn') ? 'bn' : 'en'
}
export const LANG = resolve() // ভাষা বদলালে পেজ রিলোড হয়, তাই একবার ঠিক করলেই চলে
export const locale = LANG === 'en' ? 'en-US' : 'bn-BD'
document.documentElement.lang = LANG
try { // নোটিফিকেশনের ভাষার জন্য (সার্ভিস ওয়ার্কার localStorage পড়তে পারে না)
  if (typeof caches !== 'undefined') caches.open('prefs').then(c => c.put('/__lang', new Response(LANG))).catch(() => {})
} catch { /* ignore */ }

// বাংলা লেখাই কী; ইংরেজি হলে অভিধান থেকে অনুবাদ, না পেলে আগের লেখাই থাকে
const cache = new Map<string, string>()
// ইউজারের লেখা (মেসেজ, নাম, bio, ফাইলের নাম) অনুবাদ থেকে বাঁচাতে: অদৃশ্য চিহ্ন বসে, t() সেটা দেখে ছেড়ে দেয়
const RAW = '\u2060'
export const raw = (s: string) => (LANG === 'bn' || !s ? s : s + RAW)
export function t(s: string): string {
  if (typeof s === 'string' && s.endsWith(RAW)) return s.slice(0, -1)
  if (LANG === 'bn' || typeof s !== 'string' || !/[\u0980-\u09FF]/.test(s)) return s
  const hit = cache.get(s)
  if (hit !== undefined) return hit
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!
  const core = m[2].replace(/\s+/g, ' ')
  let out: string | undefined = EN[core]
  if (out === undefined) {
    for (const [re, fn] of PATTERNS) {
      const x = core.match(re)
      if (x) { out = fn(x, t); break }
    }
  }
  const res = out === undefined ? s : m[1] + out + m[3]
  cache.set(s, res)
  return res
}

// JSX রানটাইম থেকে ডাকা: স্ক্রিনে দেখানো লেখা ও placeholder/title অনুবাদ করে
const ATTRS = ['placeholder', 'title', 'alt', 'aria-label']
const walk = (c: any): any => (typeof c === 'string' ? t(c) : Array.isArray(c) ? c.map(walk) : c)
export function fixProps(type: any, props: any) {
  if (LANG === 'bn' || typeof type !== 'string') return props
  let p = props
  if (props.children !== undefined) p = { ...p, children: walk(props.children) }
  for (const a of ATTRS) {
    if (typeof props[a] === 'string') {
      const v = t(props[a])
      if (v !== props[a]) { if (p === props) p = { ...props }; p[a] = v }
    }
  }
  return p
}
