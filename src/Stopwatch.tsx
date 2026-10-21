import { useEffect, useState } from 'react'
import './Stopwatch.css'

// Deliberately almost nothing: one number (whole minutes) and one hairline.
// Seconds are never printed — a single dot crosses the line once a minute,
// and that's the only motion on the page.
const LAP_MS = 60_000

// Just minutes below an hour; h:mm past it.
function formatMinutes(ms: number): string {
  const totalMin = Math.floor(ms / LAP_MS)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(m)
}

// Full time for screen readers, since the visual hides the seconds.
function spokenTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  return `${Math.floor(totalSec / 60)} minutes ${totalSec % 60} seconds`
}

// Elapsed is derived from timestamps, never accumulated, so it can't drift.
// startedAt null = idle (reads 0); stoppedAt set = frozen at the final time.
export default function Stopwatch({
  startedAt,
  stoppedAt,
}: {
  startedAt: number | null
  stoppedAt: number | null
}) {
  const running = startedAt !== null && stoppedAt === null
  const [now, setNow] = useState(() => Date.now())

  // Repaint every animation frame while running so the dot glides. setNow
  // lives in the rAF callback, not the effect body.
  useEffect(() => {
    if (!running) return
    let frame = requestAnimationFrame(function tick() {
      setNow(Date.now())
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [running])

  const elapsed =
    startedAt === null ? 0 : Math.max(0, (stoppedAt ?? now) - startedAt)
  const lapPct = ((elapsed % LAP_MS) / LAP_MS) * 100

  return (
    <div
      className="stopwatch"
      data-running={running}
      role="timer"
      aria-label={spokenTime(elapsed)}
    >
      <span className="stopwatch-minutes" aria-hidden="true">
        {formatMinutes(elapsed)}
      </span>
      <span className="stopwatch-line" aria-hidden="true">
        <span className="stopwatch-dot" style={{ left: `${lapPct}%` }} />
      </span>
    </div>
  )
}
