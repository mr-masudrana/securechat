import { BASE } from './api'

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
  const url = BASE.replace(/^http/, 'ws') + '/api/ws?token=' + encodeURIComponent(token)
  let ws: WebSocket, closed = false, ping = 0, retry = 1000

  const open = () => {
    ws = new WebSocket(url)
    ws.onopen = () => {
      retry = 1000
      h.onStatus(true)
      ping = window.setInterval(() => ws.readyState === 1 && ws.send('ping'), 30000)
    }
    ws.onmessage = async e => {
      if (e.data === 'pong') return
      const d = JSON.parse(e.data)
      if (d.type === 'msg') {
        try {
          // সেভ সফল হলেই ack, তারপর সার্ভার মেসেজ মুছবে
          if (await h.onMsg(d) && ws.readyState === 1)
            ws.send(JSON.stringify({ type: 'ack', k: d.k }))
        } catch { /* ack নয়: মেসেজ সার্ভারে থাকবে, রিকানেক্টে আবার আসবে */ }
      } else if (d.type === 'error') h.onError(d.error)
    }
    ws.onclose = () => {
      clearInterval(ping)
      h.onStatus(false)
      if (!closed) { setTimeout(open, retry); retry = Math.min(retry * 2, 15000) }
    }
  }
  open()

  return {
    send(to, payload) {
      const id = crypto.randomUUID()
      if (ws.readyState !== 1) { h.onError('কানেকশন নেই, একটু পরে চেষ্টা করুন'); return null }
      ws.send(JSON.stringify({ type: 'send', id, to, payload }))
      return id
    },
    isOpen() { return ws.readyState === 1 },
    close() { closed = true; ws.close() },
  }
}
