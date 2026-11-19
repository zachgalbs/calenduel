// Tells friends you're in a session while one runs: Compete counts its time as
// it goes, and shows the green dot while you're not on a break. Signed-out
// users send nothing. Failures are quiet: the row clears by itself 90 s after
// the last beat, and the session's time counts for real once it's uploaded.
import { useEffect, useRef } from 'react'
import type { LiveBeat } from './api'

const BEAT_MS = 30_000
// A request that hangs (say, a Wi-Fi switch) mustn't hold up the ones after it.
const SEND_TIMEOUT_MS = 10_000

// One at a time, in order: a break ends one beat and starts the next, and the
// "not anymore" from the first must not land after the second.
let queue: Promise<void> = Promise.resolve()

function send(beat: LiveBeat | null): void {
  queue = queue.then(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => {
          const { isSignedIn, liveBeat } = await import('./api')
          if (await isSignedIn()) await liveBeat(beat)
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), SEND_TIMEOUT_MS)
        }),
      ])
    } catch (err) {
      console.error('live status failed', err)
    } finally {
      clearTimeout(timer)
    }
  })
}

export function useLiveBeat(beat: LiveBeat | null): void {
  const since = beat?.since ?? null
  const frozenAt = beat?.frozenAt ?? null
  const day = beat?.day ?? null
  const startedAt = beat?.startedAt ?? null
  const active = since !== null && day !== null
  // Whether the last beat sent was frozen, read when the session stops.
  const frozenRef = useRef(false)

  useEffect(() => {
    if (since === null || day === null || startedAt === null) return
    const current = { since, frozenAt, day, startedAt }
    frozenRef.current = frozenAt !== null
    send(current)
    const timer = setInterval(() => send(current), BEAT_MS)
    return () => clearInterval(timer)
  }, [since, frozenAt, day, startedAt])

  // Only when the session is over (or the timer goes away), not on every
  // change: a break replaces the row rather than clearing it first. A stopped
  // session's frozen row is left alone: the database stops returning it once
  // the upload exists, and it expires in 90 s anyway. Clearing it would drop
  // the time from friends' totals if the upload were still on its way (say,
  // Compete opened right after Stop).
  useEffect(() => {
    if (!active) return
    return () => {
      if (!frozenRef.current) send(null)
    }
  }, [active])
}
