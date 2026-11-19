// Joining a group study with a session that's already running.
//
// A session lives in the tab that started it (its screen share and camera
// can't move), and a group study link opens a new tab. So the two tabs talk
// over a BroadcastChannel: the lobby asks whether a session is running
// somewhere, and can tell that tab to join the room. Messages, not the
// localStorage heartbeat: browsers slow timers in background tabs, and the
// session's tab usually is one.
import { useCallback, useEffect, useRef, useState } from 'react'

const CHANNEL = 'calenduel.session'
// The lobby asks this often, and forgets a session that stops answering.
const PING_MS = 3_000
const GONE_MS = 8_000
const JOIN_TIMEOUT_MS = 4_000

type Message =
  | { type: 'ping' }
  | { type: 'here'; room: string | null }
  | { type: 'join'; code: string }
  | { type: 'joined'; code: string }

function open(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
}

// In the tab with the session: answer the lobby, and join when it says so.
export function useAnswerSessionLink(
  active: boolean,
  room: string | null,
  onJoin: (code: string) => void,
): void {
  const roomRef = useRef(room)
  const joinRef = useRef(onJoin)
  useEffect(() => {
    roomRef.current = room
    joinRef.current = onJoin
  })

  useEffect(() => {
    if (!active) return
    const channel = open()
    if (!channel) return
    channel.onmessage = (e: MessageEvent<Message>) => {
      const msg = e.data
      if (msg.type === 'ping') {
        channel.postMessage({ type: 'here', room: roomRef.current } satisfies Message)
      } else if (msg.type === 'join') {
        joinRef.current(msg.code)
        channel.postMessage({ type: 'joined', code: msg.code } satisfies Message)
      }
    }
    // Say so straight away, so an open lobby doesn't wait for its next ping.
    channel.postMessage({ type: 'here', room: roomRef.current } satisfies Message)
    return () => channel.close()
  }, [active])
}

// In the lobby: is a session running in another tab, and which room is it in?
// join() hands it this room and resolves true once that tab confirms.
export function useOtherSession(): {
  other: { room: string | null } | null
  join: (code: string) => Promise<boolean>
} {
  const [other, setOther] = useState<{ room: string | null } | null>(null)
  const channelRef = useRef<BroadcastChannel | null>(null)
  const waitingRef = useRef<((code: string) => void) | null>(null)

  useEffect(() => {
    const channel = open()
    if (!channel) return
    channelRef.current = channel
    let lastHere = 0
    channel.onmessage = (e: MessageEvent<Message>) => {
      const msg = e.data
      if (msg.type === 'here') {
        lastHere = Date.now()
        setOther((prev) => (prev?.room === msg.room ? prev : { room: msg.room }))
      } else if (msg.type === 'joined') {
        lastHere = Date.now()
        setOther({ room: msg.code })
        waitingRef.current?.(msg.code)
      }
    }
    const ping = () => {
      if (Date.now() - lastHere > GONE_MS) setOther(null)
      channel.postMessage({ type: 'ping' } satisfies Message)
    }
    ping()
    const timer = setInterval(ping, PING_MS)
    return () => {
      clearInterval(timer)
      channel.close()
      channelRef.current = null
    }
  }, [])

  const join = useCallback((code: string) => {
    const channel = channelRef.current
    if (!channel) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        waitingRef.current = null
        resolve(false)
      }, JOIN_TIMEOUT_MS)
      waitingRef.current = (joined) => {
        if (joined !== code) return
        clearTimeout(timer)
        waitingRef.current = null
        resolve(true)
      }
      channel.postMessage({ type: 'join', code } satisfies Message)
    })
  }, [])

  return { other, join }
}
