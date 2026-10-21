import { useEffect, useState } from 'react'
import './Stopwatch.css'

// The dial: one trip around the ring = one minute. Coordinates are in SVG
// viewBox units, so the whole thing scales with its CSS width.
const LAP_MS = 60_000
const SIZE = 320
const CENTER = SIZE / 2
const RING_R = 132
const RING_C = 2 * Math.PI * RING_R
const TICK_INNER = 144
const TICK_OUTER = 152
const TICK_OUTER_MAJOR = 158 // every 5th tick reaches further out, like a watch face

const pad = (n: number) => String(n).padStart(2, '0')

// m:ss below an hour, h:mm:ss past it. Hundredths are rendered separately so
// they can sit smaller and in a monospace face (no width jitter as they spin).
function formatMain(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

// Polar → cartesian for a tick at `index` of 60, starting at 12 o'clock.
function tickPoint(index: number, r: number) {
  const angle = (index / 60) * 2 * Math.PI - Math.PI / 2
  return { x: CENTER + r * Math.cos(angle), y: CENTER + r * Math.sin(angle) }
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

  // Repaint every animation frame while running so the arc sweeps smoothly and
  // the hundredths spin. setNow lives in the rAF callback, not the effect body.
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
  const lap = Math.floor(elapsed / LAP_MS)
  const frac = (elapsed % LAP_MS) / LAP_MS
  const litTicks = Math.floor((elapsed % LAP_MS) / 1000)

  // The arc chases its own tail: even minutes it fills clockwise from 12,
  // odd minutes it erases clockwise from 12. No jarring snap back to empty.
  const filling = lap % 2 === 0
  const arcLen = (filling ? frac : 1 - frac) * RING_C
  const arcOffset = filling ? 0 : -frac * RING_C
  // On odd laps every tick starts lit and goes dark as the arc passes.
  const isLit = (i: number) => (filling ? i < litTicks : i >= litTicks)

  const tip = tickPoint(frac * 60, RING_R)
  const main = formatMain(elapsed)
  const hundredths = pad(Math.floor((elapsed % 1000) / 10))

  return (
    <div
      className="stopwatch"
      data-running={running}
      data-long={main.length > 5}
      role="timer"
      aria-label={`Elapsed ${main}`}
    >
      <svg
        className="stopwatch-dial"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-hidden="true"
      >
        {Array.from({ length: 60 }, (_, i) => {
          const major = i % 5 === 0
          const a = tickPoint(i, TICK_INNER)
          const b = tickPoint(i, major ? TICK_OUTER_MAJOR : TICK_OUTER)
          return (
            <line
              key={i}
              className="stopwatch-tick"
              data-major={major}
              data-lit={startedAt !== null && isLit(i)}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
            />
          )
        })}

        <circle className="stopwatch-track" cx={CENTER} cy={CENTER} r={RING_R} />
        <circle
          className="stopwatch-arc"
          cx={CENTER}
          cy={CENTER}
          r={RING_R}
          strokeDasharray={`${arcLen} ${RING_C}`}
          strokeDashoffset={arcOffset}
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
        />
        {startedAt !== null && (
          <circle className="stopwatch-tip" cx={tip.x} cy={tip.y} r={6} />
        )}
      </svg>

      <div className="stopwatch-readout">
        <span className="stopwatch-main">{main}</span>
        <span className="stopwatch-hundredths">.{hundredths}</span>
      </div>
    </div>
  )
}
