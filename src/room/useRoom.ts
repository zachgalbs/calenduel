// Study rooms, as the timer sees them.
//
// A room exists only while someone's in it, and its code never shows in a
// link: you invite people with your own permanent ?with=<username> link,
// which leads to whatever room you're studying in. The room this tab sits in
// is kept in sessionStorage (this tab only), so a refresh mid-session can
// find its way back to the same table.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PersonPeek, TableSeat } from '../compete/api'
import { guestSecret } from './guest'

const KEY = 'calenduel.seat'
// Presence: the database counts you as here for 90 s after a beat.
const BEAT_MS = 10_000
// How often the view re-reads the table. Quick, so arrivals show up promptly.
const POLL_MS = 4_000

// The room this tab sits in, and who it knows you as there.
export interface Seat {
  room: string
  selfId: string
  guest: boolean
}

// ?with=<username>: whose table a link invites you to.
export function withFromUrl(): string | null {
  const name = new URLSearchParams(window.location.search).get('with')
  return name && /^@?[A-Za-z0-9_]{3,20}$/.test(name) ? name.replace(/^@/, '').toLowerCase() : null
}

export function savedSeat(): Seat | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Seat) : null
  } catch {
    return null
  }
}

export function saveSeat(seat: Seat | null): void {
  try {
    if (seat) sessionStorage.setItem(KEY, JSON.stringify(seat))
    else sessionStorage.removeItem(KEY)
  } catch {
    // Storage blocked: the seat lasts as long as the page.
  }
}

// Keeps you present in the room (with your running stretch's start, or null
// on a break) and polls who else is at the table. As a guest when signed out.
// Network failures are retried quietly; a lasting one is reported.
export function useRoom(code: string, studyingSince: number | null, guest: boolean) {
  const [people, setPeople] = useState<TableSeat[]>([])
  // Two beats in a row failed: the others can't see you. Said out loud, since
  // a silent failure looks exactly like "not studying" to everyone else.
  const [beatFailing, setBeatFailing] = useState(false)
  const failuresRef = useRef(0)
  const studyingRef = useRef(studyingSince)

  const load = useCallback(async () => {
    try {
      const { roomPeek } = await import('../compete/api')
      setPeople((await roomPeek(code)) ?? [])
    } catch (err) {
      console.error('study room view failed', err)
    }
  }, [code])

  const beat = useCallback(async () => {
    try {
      const api = await import('../compete/api')
      if (guest) await api.guestBeat(code, guestSecret(), studyingRef.current)
      else await api.roomBeat(code, studyingRef.current)
      failuresRef.current = 0
      setBeatFailing(false)
    } catch (err) {
      console.error('study room presence failed', err)
      failuresRef.current += 1
      if (failuresRef.current >= 2) setBeatFailing(true)
    }
  }, [code, guest])

  // Starting or stopping a stretch tells the room at once.
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

  // Closing the tab leaves the table at once. The api module is loaded by the
  // first beat; the page can't wait for an import as it goes.
  const apiRef = useRef<Api | null>(null)
  useEffect(() => {
    void import('../compete/api').then((api) => (apiRef.current = api))
    const leave = () => apiRef.current?.leaveOnExit(code, guest ? guestSecret() : null)
    window.addEventListener('pagehide', leave)
    return () => window.removeEventListener('pagehide', leave)
  }, [code, guest])

  return { people, beatFailing }
}

type Api = typeof import('../compete/api')

// Where a ?with= link leads, read every few seconds so it follows them into
// and out of sessions. undefined while loading; null: nobody by that name.
export function usePersonPeek(username: string) {
  const [peek, setPeek] = useState<PersonPeek | null | undefined>(undefined)
  useEffect(() => {
    let closed = false
    const load = async () => {
      try {
        const api = await import('../compete/api')
        const signedIn = await api.isSignedIn()
        const p = await api.personPeek(username, signedIn ? null : guestSecret())
        if (!closed) setPeek(p)
      } catch (err) {
        // Keep the last answer; a first failure reads as "not found".
        console.error('study link lookup failed', err)
        if (!closed) setPeek((p) => (p === undefined ? null : p))
      }
    }
    void load()
    const polls = setInterval(() => void load(), POLL_MS)
    return () => {
      closed = true
      clearInterval(polls)
    }
  }, [username])
  return peek
}
