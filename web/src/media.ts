import type { StoredMsg } from './crypto'
import { raw } from './i18n'

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
  m.deleted ? 'মুছে ফেলা মেসেজ' : m.text ? raw(m.text) : (m.file ? (isAudio(m.file.m) ? 'ভয়েস মেসেজ' : isImg(m.file.m) ? 'ছবি' : raw(m.file.n)) : '')

export async function makeThumb(file: File): Promise<string | undefined> {
  if (!isImg(file.type)) return
  try {
    const bmp = await decode(file)
    const k = Math.min(1, 256 / Math.max(bmp.w, bmp.h))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.w * k))
    c.height = Math.max(1, Math.round(bmp.h * k))
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(bmp.img, 0, 0, c.width, c.height)
    bmp.done()
    const url = c.toDataURL('image/jpeg', 0.6)
    return url.length < 40_000 ? url : undefined
  } catch {
    return
  }
}

// প্রোফাইল ছবি: মাঝখান থেকে চৌকো করে ২৫৬px JPEG (সার্ভারে ছোট ডেটা হিসেবে থাকে)
export async function resizeAvatar(file: File): Promise<string> {
  const bmp = await decode(file)
  const size = 256
  const k = Math.max(size / bmp.w, size / bmp.h)
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, size, size)
  const w = bmp.w * k, h = bmp.h * k
  ctx.drawImage(bmp.img, (size - w) / 2, (size - h) / 2, w, h)
  bmp.done()
  return c.toDataURL('image/jpeg', 0.75)
}

// ছবি পাঠানোর আগে ১৬০০px-এর মধ্যে JPEG করে ছোট করা: দ্রুত আপলোড, কম খরচ, HEIC/বড় ছবির সমস্যা নেই
// createImageBitmap না চললে (কিছু ফোন/ফরম্যাট) <img> দিয়ে ডিকোড
type Decoded = { img: CanvasImageSource; w: number; h: number; done: () => void }
async function decode(file: Blob): Promise<Decoded> {
  try {
    const b = await createImageBitmap(file)
    return { img: b, w: b.width, h: b.height, done: () => b.close() }
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const el = new Image()
      el.src = url
      await el.decode()
      return { img: el, w: el.naturalWidth, h: el.naturalHeight, done: () => URL.revokeObjectURL(url) }
    } catch (e) { URL.revokeObjectURL(url); throw e }
  }
}

export async function prepareImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file
  try {
    const bmp = await decode(file)
    const k = Math.min(1, 1600 / Math.max(bmp.w, bmp.h))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.w * k))
    c.height = Math.max(1, Math.round(bmp.h * k))
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(bmp.img, 0, 0, c.width, c.height)
    bmp.done()
    const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.82))
    if (!blob) return file
    return new File([blob], (file.name.replace(/\.[^.]+$/, '') || 'photo') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}

// কভার ফটো: মাঝখান থেকে ৫:২ অনুপাতে কেটে ১০০০×৪০০ JPEG; সার্ভারের সীমার (~১২০ KB) ভেতরে আনতে মান কমানো হয়
export async function resizeCover(file: File): Promise<string> {
  const bmp = await decode(file)
  const W = 1000, H = 400
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, H)
  const k = Math.max(W / bmp.w, H / bmp.h)
  const w = bmp.w * k, h = bmp.h * k
  ctx.drawImage(bmp.img, (W - w) / 2, (H - h) / 2, w, h)
  bmp.done()
  for (const q of [0.75, 0.6, 0.45, 0.3]) {
    const url = c.toDataURL('image/jpeg', q)
    if (url.length < 150_000) return url
  }
  throw new Error('ছবিটা অনেক বড়, অন্য একটা ছবি বেছে নিন')
}

// ---------- ছবি/ফাইল পড়ার সহায়ক ----------
const EXT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
}
// কিছু ফাইল ম্যানেজার ছবির MIME টাইপ খালি দেয়; এক্সটেনশন দেখে ঠিক করি
export function fixType(file: File): File {
  if (file.type) return file
  const t = EXT_TYPES[file.name.split('.').pop()?.toLowerCase() ?? '']
  return t ? new File([file], file.name, { type: t, lastModified: file.lastModified }) : file
}
// ফাইল আগে মেমরিতে পড়ে নিই: ইনপুট খালি করার পরও (বিশেষ করে অ্যান্ড্রয়েডে) ফাইল যেন পড়া যায়
export async function snapshot(file: File): Promise<File> {
  const buf = await file.arrayBuffer()
  return fixType(new File([buf], file.name, { type: file.type, lastModified: file.lastModified }))
}
