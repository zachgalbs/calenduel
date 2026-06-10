import { useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarEvent } from './googleCalendar'
import { useSessionClock } from './session/useSessionClock'
import { useTimelapseRecorder } from './session/useTimelapseRecorder'
import { primeAudio } from './session/chime'
import { downloadBlob, timelapseName } from './media/share'
import './SessionTimer.css'

type Status = 'idle' | 'starting' | 'running' | 'encoding' | 'done'

// How often (idle only) we recompute which events are active, so an event
// becoming current flips Start on without a manual refresh.
const ACTIVE_REFRESH_MS = 30_000

// h:mm:ss past an hour, m:ss below — study sessions routinely run long.
function formatClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function formatTimeOfDay(ms: number): string {
  return new Date(ms)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .replace(' AM', ' am')
    .replace(' PM', ' pm')
}

// A study-session candidate: a *timed* event (all-day events are excluded —
// "until midnight" isn't a study goal) happening right now.
function isActiveTimed(e: CalendarEvent, nowMs: number): boolean {
  const start = e.start.dateTime
  const end = e.end.dateTime
  if (!start || !end) return false
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  return startMs <= nowMs && nowMs < endMs
}

export default function SessionTimer({
  events,
  onActiveChange,
}: {
  events: CalendarEvent[] | null
  onActiveChange: (active: boolean) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const [status, setStatus] = useState<Status>('idle')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [label, setLabel] = useState('') // task title, shown while running/done
  const [clip, setClip] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)

  const clock = useSessionClock()
  // Destructured into locals: the refs lint rule can't classify properties read
  // off the returned object, but a bare ref passed to a ref prop is fine.
  // onInterrupted = stop the session if the browser's "Stop sharing" is hit.
  const { faceVideoRef, screenVideoRef, streaming, begin, end } =
    useTimelapseRecorder(() => handleStop())
  // Guards the stop path against firing twice (Stop button + screen-share end).
  const stoppingRef = useRef(false)

  // Keep the active-event list fresh while idle. setState lives in the interval
  // callback, not the effect body, so no cascading render.
  useEffect(() => {
    if (status !== 'idle') return
    const id = setInterval(() => setNow(Date.now()), ACTIVE_REFRESH_MS)
    return () => clearInterval(id)
  }, [status])

  const active = useMemo(
    () => (events ?? []).filter((e) => isActiveTimed(e, now)),
    [events, now],
  )

  // A session is "in progress" from the moment Start is pressed through saving —
  // i.e. everything except idle and the post-session review. The parent uses
  // this to hide the calendar and switch to the condensed full-screen layout.
  const inProgress =
    status === 'starting' || status === 'running' || status === 'encoding'

  // Lift that state to the parent. onActiveChange is a stable setState fn, so
  // this fires only when inProgress actually flips.
  useEffect(() => {
    onActiveChange(inProgress)
  }, [inProgress, onActiveChange])

  // Derive the selection during render (no effect): honor the user's pick if
  // it's still active, otherwise fall back to the first active event.
  const selected =
    active.find((e) => e.id === selectedId) ?? active[0] ?? null
  const endMs = selected?.end.dateTime ? Date.parse(selected.end.dateTime) : null

  async function handleStart() {
    if (!selected || endMs === null) return
    // Unlock audio inside the click gesture, BEFORE the camera await — the
    // gesture context is gone once we await, and the chime fires later.
    primeAudio()
    setError(null)
    setStatus('starting')
    try {
      await begin() // requests screen + camera; rejects → session is blocked
      setLabel(selected.summary ?? 'Study session')
      clock.start(Math.max(0, endMs - Date.now()))
      setStatus('running')
    } catch {
      setError('Screen and camera access are needed to record your session.')
      setStatus('idle')
    }
  }

  async function handleStop() {
    if (stoppingRef.current) return // ignore a double-fire (Stop click + share end)
    stoppingRef.current = true
    clock.stop()
    setStatus('encoding')
    const blob = await end()
    setClip(blob)
    setStatus('done')
  }

  function handleNewSession() {
    clock.reset()
    setClip(null)
    setError(null)
    setNow(Date.now())
    stoppingRef.current = false
    setStatus('idle')
  }

  function handleDownload() {
    if (clip) downloadBlob(clip, timelapseName(clip, label))
  }

  // Heading only when it carries information: the task title while a session
  // runs, "Nice work" on completion. Idle shows none — the picker/hint says it.
  const heading = status === 'done' ? 'Nice work' : status === 'idle' ? null : label
  const progressPct =
    clock.goalMs > 0 ? Math.min(100, (clock.elapsedMs / clock.goalMs) * 100) : 0
  const overMs = Math.max(0, clock.elapsedMs - clock.goalMs)

  return (
    <section className="session" data-focus={inProgress}>
      {heading && <h2>{heading}</h2>}

      {/* Screen-dominant preview with the webcam inset, mirroring the recorded
          output. Shown whenever the feeds are live (running + encoding). */}
      {streaming && (
        <div className="session-stage">
          <video
            ref={screenVideoRef}
            className="session-screen"
            autoPlay
            playsInline
            muted
          />
          <video
            ref={faceVideoRef}
            className="session-face"
            autoPlay
            playsInline
            muted
          />
        </div>
      )}

      {status === 'idle' && (
        <>
          {events === null && (
            <p className="session-hint">
              Connect your calendar above to start a session.
            </p>
          )}
          {events !== null && active.length === 0 && (
            <p className="session-hint">No active event.</p>
          )}

          {selected && endMs !== null && (
            <>
              {active.length > 1 ? (
                <select
                  className="session-picker"
                  value={selected.id}
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  {active.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.summary ?? '(no title)'}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="session-task">{selected.summary ?? '(no title)'}</p>
              )}

              <p className="session-meta">
                ends {formatTimeOfDay(endMs)} ·{' '}
                {Math.max(0, Math.round((endMs - now) / 60_000))} min left
              </p>

              <button
                type="button"
                className="session-start"
                onClick={handleStart}
              >
                Start
              </button>
            </>
          )}
        </>
      )}

      {status === 'starting' && (
        <button type="button" className="session-start" disabled>
          Starting…
        </button>
      )}

      {status === 'running' && (
        <>
          <p className="session-clock" data-over={clock.reachedGoal}>
            {formatClock(clock.elapsedMs)}
          </p>
          <div className="session-progress">
            <div
              className="session-progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="session-goal">
            {clock.reachedGoal && <span className="check">✓ </span>}
            goal {formatClock(clock.goalMs)}
            {clock.reachedGoal && overMs > 0 && ` · +${formatClock(overMs)} over`}
          </p>
          <button type="button" className="session-stop" onClick={handleStop}>
            Stop
          </button>
        </>
      )}

      {status === 'encoding' && (
        <>
          <p className="session-clock">{formatClock(clock.elapsedMs)}</p>
          <button type="button" className="session-stop" disabled>
            Saving…
          </button>
        </>
      )}

      {status === 'done' && (
        <>
          <p className="session-clock" data-over={clock.reachedGoal}>
            {formatClock(clock.elapsedMs)}
          </p>
          <p className="session-goal">of {formatClock(clock.goalMs)} goal</p>
          <div className="session-actions">
            {clip && clip.size > 0 && (
              <button
                type="button"
                className="session-start"
                onClick={handleDownload}
              >
                Download
              </button>
            )}
            <button
              type="button"
              className="session-stop"
              onClick={handleNewSession}
            >
              New session
            </button>
          </div>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </section>
  )
}
