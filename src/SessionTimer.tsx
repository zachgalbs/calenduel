import { useEffect, useRef, useState } from 'react'
import Stopwatch from './Stopwatch'
import { useTimelapseRecorder } from './session/useTimelapseRecorder'
import { downloadBlob, timelapseName } from './media/share'
import { saveSession } from './db'
import './SessionTimer.css'

type Status = 'idle' | 'starting' | 'running' | 'encoding' | 'done'

// Pure stopwatch: no goal, so every session gets the same label.
const TASK = 'Study session'

export default function SessionTimer({
  onActiveChange,
  onSessionSaved,
}: {
  onActiveChange: (active: boolean) => void
  onSessionSaved?: () => void
}) {
  const [status, setStatus] = useState<Status>('idle')
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [stoppedAt, setStoppedAt] = useState<number | null>(null)
  const [clip, setClip] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Destructured into locals: the refs lint rule can't classify properties read
  // off the returned object, but a bare ref passed to a ref prop is fine.
  // onInterrupted = stop the session if the browser's "Stop sharing" is hit.
  const { faceVideoRef, streaming, begin, end } =
    useTimelapseRecorder(() => handleStop())
  // Guards the stop path against firing twice (Stop button + screen-share end).
  const stoppingRef = useRef(false)

  // A session is "in progress" from the moment Start is pressed through saving.
  // The parent uses this to hide the nav for a distraction-free screen.
  const inProgress =
    status === 'starting' || status === 'running' || status === 'encoding'

  // Lift that state to the parent. onActiveChange is a stable setState fn, so
  // this fires only when inProgress actually flips.
  useEffect(() => {
    onActiveChange(inProgress)
  }, [inProgress, onActiveChange])

  // One click does everything: screen picker, camera, recording, stopwatch.
  // (getDisplayMedia needs this click's user gesture — it can't run on load.)
  async function handleStart() {
    setError(null)
    setStatus('starting')
    try {
      await begin()
      setStartedAt(Date.now())
      setStatus('running')
    } catch {
      setError('Screen and camera access are needed to record your session.')
      setStatus('idle')
    }
  }

  async function handleStop() {
    if (stoppingRef.current || startedAt === null) return // ignore a double-fire
    stoppingRef.current = true
    const stopAt = Date.now()
    setStoppedAt(stopAt) // freezes the stopwatch on the final time
    setStatus('encoding')
    const blob = await end()
    const validClip = blob && blob.size > 0 ? blob : null
    await saveSession(
      { startedAt, task: TASK, goalMs: 0, elapsedMs: stopAt - startedAt },
      validClip,
    )
    onSessionSaved?.()
    setClip(blob)
    setStatus('done')
  }

  function handleNewSession() {
    setStartedAt(null)
    setStoppedAt(null)
    setClip(null)
    setError(null)
    stoppingRef.current = false
    setStatus('idle')
  }

  function handleDownload() {
    if (clip) downloadBlob(clip, timelapseName(clip, TASK))
  }

  return (
    <section className="session" data-focus={inProgress}>
      {/* Camera-only preview. The screen is recorded but never shown — a live
          preview of your own screen reflects itself forever. Shown whenever
          the feeds are live (running + encoding). */}
      {streaming && (
        <div className="session-stage">
          <video
            ref={faceVideoRef}
            className="session-face"
            autoPlay
            playsInline
            muted
          />
          {status === 'running' && <span className="session-rec">Rec</span>}
        </div>
      )}

      <Stopwatch startedAt={startedAt} stoppedAt={stoppedAt} />

      <div className="session-actions">
        {status === 'idle' && (
          <button type="button" className="session-start" onClick={handleStart}>
            Start
          </button>
        )}

        {status === 'starting' && (
          <button type="button" className="session-start" disabled>
            Starting…
          </button>
        )}

        {status === 'running' && (
          <button type="button" className="session-stop" onClick={handleStop}>
            Stop
          </button>
        )}

        {status === 'encoding' && (
          <button type="button" className="session-stop" disabled>
            Saving…
          </button>
        )}

        {status === 'done' && (
          <>
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
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  )
}
