// The study room you're in, and a live view of it.
//
// The room's code is kept in sessionStorage (this tab only) and in the URL as
// ?room=CODE, so a refresh stays in the room and the link is the invitation.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RoomState } from '../compete/api'

const KEY = 'calenduel.room'
// Presence: the database counts you as here for 90 s after a beat.
const BEAT_MS = 10_000
// How often the view re-reads the room. Quick, so arrivals show up promptly.
const POLL_MS = 4_000

export function roomFromUrl(): string | null {
  const code = new URLSearchParams(window.location.search).get('room')
  return code && /^[A-Za-z0-9]{6,20}$/.test(code) ? code.toUpperCase() : null
}

export function savedRoom(): string | null {
  try {
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function saveRoom(code: string | null): void {
  try {
    if (code) sessionStorage.setItem(KEY, code)
    else sessionStorage.removeItem(KEY)
  } catch {
    // Storage blocked: the room lasts as long as the page.
  }
}

export function roomLink(code: string): string {
  return `${window.location.origin}/?room=${code}`
}

// 1:05:09, the way the timer shows a running session.
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`
}

// A ticking clock, only while something on screen is live.
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

// Keeps you present in the room (with your running session's start time, or
// null) and polls who else is there. Network failures are retried quietly; a
// lasting error is reported.
export function useRoom(code: string, studyingSince: number | null) {
  const [state, setState] = useState<RoomState | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Two beats in a row failed: the others can't see you. Said out loud, since
  // a silent failure looks exactly like "not studying" to everyone else.
  const [beatFailing, setBeatFailing] = useState(false)
  const failuresRef = useRef(0)
  const studyingRef = useRef(studyingSince)

  const load = useCallback(async () => {
    try {
      const { roomState } = await import('../compete/api')
      setState(await roomState(code))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lost touch with the study room.')
    }
  }, [code])

  const beat = useCallback(async () => {
    try {
      const { roomBeat } = await import('../compete/api')
      await roomBeat(code, studyingRef.current)
      failuresRef.current = 0
      setBeatFailing(false)
    } catch (err) {
      console.error('study room presence failed', err)
      failuresRef.current += 1
      if (failuresRef.current >= 2) setBeatFailing(true)
    }
  }, [code])

  // Starting or stopping a session tells the room at once.
  useEffect(() => {
    studyingRef.current = studyingSince
    // eslint-disable-next-line react-hooks/set-state-in-effect -- presence sync, not derived state
    void beat().then(load)
  }, [studyingSince, beat, load])

  useEffect(() => {
    const beats = setInterval(() => void beat(), BEAT_MS)
    const polls = setInterval(() => void load(), POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(beats)
      clearInterval(polls)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [beat, load])

  return { state, error, beatFailing, reload: load }
}

// A member's time in this room, counting a session running now.
export function memberMs(m: { bankedMs: number; liveSince: number | null }, now: number): number {
  return m.bankedMs + (m.liveSince !== null ? Math.max(0, now - m.liveSince) : 0)
}
