import { BASE, call } from './api'

export type Incoming = { k: string; id: string; ts: number; from: string; payload: string }
export type Conn = {
  send: (to: string, payload: string) => string | null
  isOpen: () => boolean
  close: () => void
}

export function connect(
  token: string,
  h: {
    onMsg: (m: Incoming) => Promise<boolean>
    onStatus: (ok: boolean) => void
    onError: (e: string) => void
  },
): Conn {
  const wsBase = BASE.replace(/^http/, 'ws')
  let ws: WebSocket | null = null, closed = false, ping = 0, retry = 1000

  const again = () => { if (!closed) { setTimeout(open, retry); retry = Math.min(retry * 2, 15000) } }

  const open = async () => {
    // প্রতিবার নতুন এক-বারের টিকেট নিই, সেশন টোকেন URL-এ যায় না
    let ticket: string
    try {
      ticket = (await call('/api/ws-ticket', 'POST', undefined, token)).ticket
    } catch (e: any) {
      if (e.message === 'Unauthorized') { closed = true; h.onError('সেশন শেষ হয়েছে, আবার লগইন করুন') }
      else again()
      return
    }
    if (closed) return
    const sock = new WebSocket(wsBase + '/api/ws?ticket=' + encodeURIComponent(ticket))
    ws = sock
    sock.onopen = () => {
      retry = 1000
      h.onStatus(true)
      ping = window.setInterval(() => sock.readyState === 1 && sock.send('ping'), 30000)
    }
    sock.onmessage = async e => {
      if (e.data === 'pong') return
      const d = JSON.parse(e.data)
      if (d.type === 'msg') {
        try {
          // সেভ সফল হলেই ack, তারপর সার্ভার মেসেজ মুছবে
          if (await h.onMsg(d) && sock.readyState === 1)
            sock.send(JSON.stringify({ type: 'ack', k: d.k }))
        } catch { /* ack নয়: মেসেজ সার্ভারে থাকবে, রিকানেক্টে আবার আসবে */ }
      } else if (d.type === 'error') h.onError(d.error)
    }
    sock.onclose = () => {
      clearInterval(ping)
      h.onStatus(false)
      again()
    }
  }
  open()

  return {
    send(to, payload) {
      if (!ws || ws.readyState !== 1) { h.onError('কানেকশন নেই, একটু পরে চেষ্টা করুন'); return null }
      const id = crypto.randomUUID()
      ws.send(JSON.stringify({ type: 'send', id, to, payload }))
      return id
    },
    isOpen: () => ws?.readyState === 1,
    close() { closed = true; ws?.close() },
  }
}
