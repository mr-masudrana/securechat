import type { StoredMsg } from './crypto'

const SAFE_IMG = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
export const isImg = (m: string) => SAFE_IMG.includes(m)
// প্রেরকের দাবি করা টাইপে বিশ্বাস নেই: ছবি ছাড়া সব octet-stream
export const safeType = (m: string) => (isImg(m) ? m : 'application/octet-stream')

export const fmtSize = (n: number) =>
  n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'

export const previewText = (m: StoredMsg) =>
  m.text || (m.file ? (isImg(m.file.m) ? '📷 ছবি' : '📎 ' + m.file.n) : '')

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
