import { useEffect, useState } from 'react'
import { NOT_PAUSED, studiedMs, type PauseState } from './session/elapsed'
import './Stopwatch.css'

// Deliberately almost nothing: one big number (whole minutes) with the seconds
// tucked in small beside it.
const LAP_MS = 60_000
// Re-read the clock a few times a second so each second flips close to when
// it actually ticks over (a 1s interval could lag by up to a second).
const TICK_MS = 250

// Just minutes below an hour; h:mm past it.
function formatMinutes(ms: number): string {
  const totalMin = Math.floor(ms / LAP_MS)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(m)
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
}: {
  startedAt: number | null
  stoppedAt: number | null
  pause?: PauseState
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
  const at = stoppedAt ?? (paused ? pause.pausedAt! : now)
  const elapsed = startedAt === null ? 0 : studiedMs(startedAt, at, pause)
  const seconds = String(Math.floor((elapsed % LAP_MS) / 1000)).padStart(2, '0')

  return (
    <div
      className="stopwatch"
      data-paused={paused && stoppedAt === null}
      role="timer"
      aria-label={paused && stoppedAt === null ? `Paused at ${spokenTime(elapsed)}` : spokenTime(elapsed)}
    >
      <span className="stopwatch-minutes" aria-hidden="true">
        {formatMinutes(elapsed)}
        <span className="stopwatch-seconds">:{seconds}</span>
      </span>
    </div>
  )
}
