import { useEffect, useState } from 'react'
import { NOT_PAUSED, studiedMs, type PauseState } from './session/elapsed'
import './Stopwatch.css'

// Deliberately almost nothing: the time as m:ss (h:mm:ss past an hour), one
// size and one colour throughout. Each digit sits in its own fixed-width slot
// and rolls up into place when it changes; the others stay perfectly still.
// Re-read the clock a few times a second so each second flips close to when
// it actually ticks over (a 1s interval could lag by up to a second).
const TICK_MS = 250

// m:ss below an hour; h:mm:ss past it.
function formatClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const sec = String(totalSec % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

// Full time in words for screen readers.
function spokenTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  return `${Math.floor(totalSec / 60)} minutes ${totalSec % 60} seconds`
}

// Elapsed is derived from timestamps, never accumulated, so it can't drift.
// startedAt null = idle (reads 0); stoppedAt set = frozen at the final time.
// Breaks don't count, so a paused stopwatch stands still.
export default function Stopwatch({
  startedAt,
  stoppedAt,
  pause = NOT_PAUSED,
  resumedAt = null,
}: {
  startedAt: number | null
  stoppedAt: number | null
  pause?: PauseState
  // When studying last (re)started. `now` only ticks while running, so just
  // after a resume it still holds a time from before the break, which, with
  // the whole break now taken out, would read as too little. Never earlier.
  resumedAt?: number | null
}) {
  const paused = pause.pausedAt !== null
  const running = startedAt !== null && stoppedAt === null && !paused
  const [now, setNow] = useState(() => Date.now())

  // Tick while running. setNow lives in the interval callback, not the effect
  // body, so no cascading render.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [running])

  // While paused, read at the pause itself: `now` stops updating then.
  const at = stoppedAt ?? (paused ? pause.pausedAt! : Math.max(now, resumedAt ?? 0))
  const elapsed = startedAt === null ? 0 : studiedMs(startedAt, at, pause)
  const chars = [...formatClock(elapsed)]

  return (
    <div
      className="stopwatch"
      data-paused={paused && stoppedAt === null}
      role="timer"
      aria-label={paused && stoppedAt === null ? `Paused at ${spokenTime(elapsed)}` : spokenTime(elapsed)}
    >
      <span className="stopwatch-digits" aria-hidden="true">
        {chars.map((c, i) => {
          // Slots are counted from the right, so 9:59 becoming 10:00 adds a
          // slot on the left instead of reshuffling the seconds.
          const slot = chars.length - i
          return c === ':' ? (
            <span key={`colon-${slot}`} className="stopwatch-colon">:</span>
          ) : (
            <span key={`slot-${slot}`} className="stopwatch-slot">
              {/* Keyed by its value: a new digit mounts, and mounting is
                  what plays the roll. */}
              <span key={c} className="stopwatch-digit">{c}</span>
            </span>
          )
        })}
      </span>
    </div>
  )
}
