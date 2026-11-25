import type { StoredMsg } from './crypto'

const SAFE_IMG = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
export const isImg = (m: string) => SAFE_IMG.includes(m)
const SAFE_AUDIO = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav', 'audio/x-m4a']
export const isAudio = (m: string) => SAFE_AUDIO.includes(m)
export const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
// প্রেরকের দাবি করা টাইপে বিশ্বাস নেই: ছবি ছাড়া সব octet-stream
export const safeType = (m: string) => (isImg(m) || isAudio(m) ? m : 'application/octet-stream')

export const fmtSize = (n: number) =>
  n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'

export const previewText = (m: StoredMsg) =>
  m.deleted ? 'মুছে ফেলা মেসেজ' : m.text || (m.file ? (isAudio(m.file.m) ? 'ভয়েস মেসেজ' : isImg(m.file.m) ? 'ছবি' : m.file.n) : '')

export async function makeThumb(file: File): Promise<string | undefined> {
  if (!isImg(file.type)) return
  try {
    const bmp = await createImageBitmap(file)
    const k = Math.min(1, 256 / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * k))
    c.height = Math.max(1, Math.round(bmp.height * k))
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close()
    const url = c.toDataURL('image/jpeg', 0.6)
    return url.length < 40_000 ? url : undefined
  } catch {
    return
  }
}

// প্রোফাইল ছবি: মাঝখান থেকে চৌকো করে ২৫৬px JPEG (সার্ভারে ছোট ডেটা হিসেবে থাকে)
export async function resizeAvatar(file: File): Promise<string> {
  const bmp = await createImageBitmap(file)
  const size = 256
  const k = Math.max(size / bmp.width, size / bmp.height)
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, size, size)
  const w = bmp.width * k, h = bmp.height * k
  ctx.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h)
  bmp.close()
  return c.toDataURL('image/jpeg', 0.75)
}

// ছবি পাঠানোর আগে ১৬০০px-এর মধ্যে JPEG করে ছোট করা: দ্রুত আপলোড, কম খরচ, HEIC/বড় ছবির সমস্যা নেই
export async function prepareImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file
  try {
    const bmp = await createImageBitmap(file)
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * k))
    c.height = Math.max(1, Math.round(bmp.height * k))
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close()
    const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.82))
    if (!blob) return file
    if (k === 1 && file.type === 'image/jpeg' && blob.size >= file.size) return file
    return new File([blob], (file.name.replace(/\.[^.]+$/, '') || 'photo') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}
