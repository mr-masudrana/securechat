export const BASE: string =
  ((import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:8787').replace(/\/$/, '')

export async function call(path: string, method: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'কিছু একটা ভুল হয়েছে')
  return data
}

export async function uploadBlob(to: string, data: ArrayBuffer, token: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(BASE + '/api/media?to=' + encodeURIComponent(to), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
      body: data,
    })
  } catch {
    throw new Error('আপলোডে নেটওয়ার্ক সমস্যা হয়েছে, আবার চেষ্টা করুন')
  }
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((j.error || 'আপলোড ব্যর্থ হয়েছে') + ` (${res.status})`)
  return j.id
}

// ফাইল না পেলে null (মেয়াদ শেষ বা মুছে গেছে)
export async function downloadBlob(id: string, token: string): Promise<ArrayBuffer | null> {
  const res = await fetch(BASE + '/api/media/' + id, { headers: { Authorization: 'Bearer ' + token } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error('ডাউনলোড ব্যর্থ হয়েছে')
  return res.arrayBuffer()
}
