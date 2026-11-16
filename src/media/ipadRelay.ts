// The wireless iPad: the Calenduel Link iPad app sends its screen through the
// focus worker (worker/src/ipad.js), and this receives it. No Mac app needed.
// Pairing (QR code on the Account page) ties the iPad to the signed-in account.
import { FOCUS_ENDPOINT } from '../focus/endpoint'
import type { HelperFeed } from './ipadHelper'

// What the iPad's Camera opens. With Calenduel Link installed it's a universal
// link straight into the app; without it, a page pointing to the App Store. The
// token is in the fragment, so it never reaches a server.
const PAIR_LINK = 'https://calenduel.com/ipad/pair#'

async function token(): Promise<string | null> {
  const { focusToken } = await import('../compete/api')
  return focusToken()
}

async function call<T>(action: 'pair' | 'unpair' | 'status'): Promise<T> {
  const jwt = await token()
  if (!jwt) throw new Error('Sign in on the Compete tab to connect an iPad.')
  const response = await fetch(`${FOCUS_ENDPOINT}/ipad/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? 'Something went wrong. Please try again.')
  return body as T
}

export interface RelayStatus {
  paired: boolean
  seen: boolean // the app has connected with the current pairing
  connected: boolean // the app is broadcasting right now
}

export const relayStatus = () => call<RelayStatus>('status')
export const unpairIpad = () => call<{ ok: true }>('unpair')

// A fresh pairing (any previous iPad is cut off). Returns the link to show as
// a QR code.
export async function pairIpad(): Promise<string> {
  const { token: device } = await call<{ token: string }>('pair')
  return PAIR_LINK + device
}

export interface RelayWatch {
  hasIpad: () => boolean
  // The iPad as a live stream, like the USB helper's feed. onLost fires once
  // if the iPad stops broadcasting or the connection drops.
  openFeed: (onLost: () => void) => HelperFeed
  close: () => void
}

// Listens for the paired iPad while a session is live. onChange fires when it
// comes or goes. Resolves null when signed out.
export async function watchRelay(onChange: () => void): Promise<RelayWatch | null> {
  if (!(await token())) return null
  const url = `${FOCUS_ENDPOINT.replace(/^http/, 'ws')}/ipad/watch`
  let socket: WebSocket | null = null
  let ipadConnected = false
  let closed = false
  let retry = 1000
  let feed: { draw: (blob: Blob) => void; lost: () => void } | null = null

  async function connect() {
    const jwt = await token()
    if (closed || !jwt) return
    const ws = new WebSocket(url, ['calenduel', jwt])
    socket = ws
    ws.onopen = () => {
      retry = 1000
      if (feed) ws.send('want')
    }
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data) as { type?: string; connected?: boolean }
        if (message.type !== 'ipad') return
        ipadConnected = message.connected === true
        if (!ipadConnected) feed?.lost()
        onChange()
      } else {
        feed?.draw(event.data as Blob)
      }
    }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = null
      if (ipadConnected) {
        ipadConnected = false
        feed?.lost()
        onChange()
      }
      if (!closed) {
        setTimeout(() => void connect(), retry)
        retry = Math.min(retry * 2, 30_000)
      }
    }
  }
  void connect()

  return {
    hasIpad: () => ipadConnected,
    close() {
      closed = true
      feed?.lost()
      socket?.close()
    },
    openFeed(onLost) {
      const canvas = document.createElement('canvas')
      canvas.width = 2
      canvas.height = 2
      const ctx = canvas.getContext('2d')!
      const stream = canvas.captureStream()
      let stopped = false
      let settle: (ok: boolean) => void = () => {}
      const ready = new Promise<boolean>((resolve) => {
        settle = resolve
      })
      // Frames can overlap while one is decoding; draw only the newest.
      let latest = 0

      const stop = () => {
        if (stopped) return
        stopped = true
        settle(false)
        for (const track of stream.getTracks()) track.stop()
        if (feed === mine) {
          feed = null
          if (socket?.readyState === WebSocket.OPEN) socket.send('idle')
        }
      }
      const mine = {
        async draw(blob: Blob) {
          const n = ++latest
          const bitmap = await createImageBitmap(blob).catch(() => null)
          if (!bitmap) return
          if (stopped || n !== latest) return bitmap.close()
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width // rotating the iPad changes the shape
            canvas.height = bitmap.height
          }
          ctx.drawImage(bitmap, 0, 0)
          bitmap.close()
          settle(true)
        },
        lost() {
          if (stopped) return
          stop()
          onLost()
        },
      }
      feed?.lost() // one feed at a time
      feed = mine
      if (socket?.readyState === WebSocket.OPEN) socket.send('want')
      return { stream, ready, stop }
    },
  }
}
