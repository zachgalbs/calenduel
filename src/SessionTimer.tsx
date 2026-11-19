import { useEffect, useRef, useState } from 'react'
import { useLiveBeat } from './compete/useLiveBeat'
import Stopwatch from './Stopwatch'
import { useTimelapseRecorder } from './session/useTimelapseRecorder'
import { downloadBlob, timelapseName } from './media/share'
import { DEFAULT_SESSION_NAME, SESSION_NAME_MAX, saveSession } from './db'
import { formatStudyTime, localDay } from './compete/stats'
import {
  clearActive,
  HEARTBEAT_MS,
  interruptedSession,
  pauseOf,
  tabId,
  writeActive,
  type ActiveSession,
} from './session/activeSession'
import RoomPanel, { SoloTable } from './room/RoomPanel'
import RoomInvite from './room/RoomInvite'
import { roomLink } from './room/useRoom'
import { sortSessions } from './subjects/sort'
import { liveSpan, NOT_PAUSED, pausedUntil, studiedMs, type PauseState } from './session/elapsed'

// File a just-saved session under a subject, in the background.
function sortIntoSubject() {
  void sortSessions()
}
import './SessionTimer.css'

type Status = 'idle' | 'starting' | 'running' | 'encoding' | 'done'

// Resuming carries on the same session, gap included, so it's only offered
// soon after it stopped: a refresh, not a laptop closed overnight.
const RESUME_WINDOW_MS = 10 * 60_000

// A break this long ends the session: it was probably forgotten, and the
// screen share shouldn't sit open all afternoon. The study time is saved.
const PAUSE_LIMIT_MS = 30 * 60_000

// While a session runs, the controls step back once the mouse and keyboard
// have been still this long, and come back at the next touch.
const STILL_MS = 3_000

function useStill(active: boolean): boolean {
  const [still, setStill] = useState(false)
  useEffect(() => {
    if (!active) return
    let timer = setTimeout(() => setStill(true), STILL_MS)
    const wake = () => {
      setStill(false)
      clearTimeout(timer)
      timer = setTimeout(() => setStill(true), STILL_MS)
    }
    const events = ['pointermove', 'pointerdown', 'keydown', 'focusin'] as const
    for (const e of events) window.addEventListener(e, wake)
    return () => {
      clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, wake)
    }
  }, [active])
  return active && still
}

// Error names like QuotaExceededError are the useful part when someone sends a
// screenshot of a failure.
function describe(e: unknown): string {
  if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message
  return String(e)
}

export default function SessionTimer({
  room = null,
  onRoomChange,
  autoStart = false,
  onAutoStarted,
  onActiveChange,
  onSessionSaved,
}: {
  // The study room: the one this tab's sessions are in, or one a link or a
  // Join click brought us to. Kept in the URL, so that URL is the invite.
  room?: string | null
  onRoomChange: (code: string | null) => void
  // Start straight away: Compete's Join click brought us here.
  autoStart?: boolean
  onAutoStarted?: () => void
  onActiveChange: (active: boolean) => void
  // May return the upload, so friends keep seeing the time until it lands.
  onSessionSaved?: () => Promise<unknown> | void
}) {
  const [status, setStatus] = useState<Status>('idle')
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [stoppedAt, setStoppedAt] = useState<number | null>(null)
  // The start of a stopped session whose upload is still on its way.
  const [uploadingFor, setUploadingFor] = useState<number | null>(null)
  const [pause, setPause] = useState<PauseState>(NOT_PAUSED)
  const paused = pause.pausedAt !== null
  // When the current stretch of studying began (the start, or the last resume).
  // That's what the study room gets: it banks each stretch when it ends, so
  // sending the session's start again after a break would count time twice.
  const [stretchFrom, setStretchFrom] = useState<number | null>(null)
  // The room this tab has actually joined or created. Until it matches `room`,
  // that room is only an invitation.
  const [joinedRoom, setJoinedRoom] = useState<string | null>(null)
  const inRoom = room !== null && joinedRoom === room
  const still = useStill(status === 'running')
  const [linkCopied, setLinkCopied] = useState(false)
  const [clip, setClip] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Optional, and never required to start: Start stays one click. It can be
  // typed before or during the session, and is fixed once Stop is pressed
  // (after that, rename it on the Sessions page).
  const [name, setName] = useState('')
  const task = name.trim() || DEFAULT_SESSION_NAME
  // A session cut off by a refresh or a closed tab, read once on load.
  const [interrupted, setInterrupted] = useState<ActiveSession | null>(() =>
    interruptedSession(Date.now()),
  )
  const [notice, setNotice] = useState<string | null>(null)

  // Destructured into locals: the refs lint rule can't classify properties read
  // off the returned object, but a bare ref passed to a ref prop is fine.
  // onInterrupted = stop the session if the browser's "Stop sharing" is hit.
  const {
    faceVideoRef,
    streaming,
    begin,
    addIpad,
    removeIpad,
    ipadStream,
    setPaused: setRecorderPaused,
    end,
  } = useTimelapseRecorder(() => handleStop())
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

  // Friends see this session's time count up on Compete, and the green dot
  // while not on a break. After Stop the time stays up, frozen, until the
  // upload lands, so it never drops out of their totals in between. The room
  // gives them a Join button, a break included; not once the session's over.
  const live =
    startedAt !== null &&
    (status === 'running' ||
      status === 'encoding' ||
      (status === 'done' && uploadingFor === startedAt))
  useLiveBeat(
    live
      ? {
          ...liveSpan(startedAt, pause, status === 'running' ? null : stoppedAt),
          day: localDay(startedAt), // the day the upload is filed under
          startedAt, // lets the database drop this once the upload exists
          room: status === 'running' && inRoom ? room : null,
        }
      : null,
  )

  // While running, keep a record that outlives the page, refreshed on a
  // heartbeat and once more as the page goes away.
  useEffect(() => {
    if (status !== 'running' || startedAt === null) return
    const beat = () =>
      writeActive({
        startedAt,
        name: task,
        lastSeen: Date.now(),
        tabId: tabId(),
        pausedMs: pause.pausedMs,
        pausedAt: pause.pausedAt,
      })
    beat()
    const timer = setInterval(beat, HEARTBEAT_MS)
    window.addEventListener('pagehide', beat)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', beat)
    }
  }, [status, startedAt, task, pause])

  // End a break that's run too long. Through a ref, so the timer always calls
  // the current handleStop (the name can still change during a break).
  const stopRef = useRef<() => void>(() => {})
  useEffect(() => {
    stopRef.current = () => void handleStop()
  })
  useEffect(() => {
    if (status !== 'running' || pause.pausedAt === null) return
    const left = PAUSE_LIMIT_MS - (Date.now() - pause.pausedAt)
    const timer = setTimeout(() => {
      setNotice('Your break ran past 30 minutes, so the session was ended and saved.')
      stopRef.current()
    }, Math.max(0, left))
    return () => clearTimeout(timer)
  }, [status, pause.pausedAt])


  // Arriving from a Join click on Compete: start once, on that click's
  // gesture (a browser counts a click as one for a few seconds). If it has
  // lapsed, the picker refuses and the Start button is right here.
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || status !== 'idle') return
    autoStartedRef.current = true
    onAutoStarted?.()
    void handleStart()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, [autoStart])

  // Ask before a refresh or close throws away a session in progress.
  useEffect(() => {
    if (!inProgress) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [inProgress])

  // One click does everything: screen picker, camera, recording, stopwatch.
  // (getDisplayMedia needs this click's user gesture — it can't run on load.)
  // resumeFrom carries on an interrupted session from its original start.
  async function handleStart(resumeFrom?: number, pausedBefore = 0) {
    setError(null)
    setNotice(null)
    setStatus('starting')
    try {
      await begin()
      setStartedAt(resumeFrom ?? Date.now())
      setPause({ pausedMs: pausedBefore, pausedAt: null })
      setStretchFrom(Date.now())
      setInterrupted(null)
      setStatus('running')
    } catch {
      setError('Screen and camera access are needed to record your session.')
      setStatus('idle')
      return
    }
    enterRoom()
  }

  // Every signed-in session is in a study room, so friends can always join.
  // In the background: the session is already running, and a room that can't
  // be reached just means studying alone.
  //   - A room from a link or a Join click: join it.
  //   - This tab's room from an earlier session: stay only if someone else is
  //     still studying in it. Otherwise it's over, and a fresh one starts.
  //   - No room: make one.
  function enterRoom() {
    const current = room
    const leftover = current !== null && current === joinedRoom
    void (async () => {
      const api = await import('./compete/api')
      if (!(await api.isSignedIn())) {
        if (current) onRoomChange(null)
        return
      }
      if (current) {
        try {
          let stay = true
          if (leftover) {
            const [me, state] = await Promise.all([api.ensureProfile(), api.roomState(current)])
            stay = state.members.some((m) => m.id !== me.id && m.liveSince !== null)
          }
          if (stay) {
            await api.joinRoom(current) // idempotent; also friends you with everyone in it
            setJoinedRoom(current)
            return
          }
        } catch (err) {
          console.error('joining the study room failed; making a new one', err)
        }
      }
      const code = await api.createRoom()
      onRoomChange(code)
      setJoinedRoom(code)
    })().catch((err) => console.error('study room failed', err))
  }

  async function handleCopyLink() {
    if (!room) return
    try {
      await navigator.clipboard.writeText(roomLink(room))
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    } catch {
      setNotice(`Couldn't copy it. The link is ${roomLink(room)}`)
    }
  }

  function handleResume() {
    if (!interrupted) return
    setName(interrupted.name === DEFAULT_SESSION_NAME ? '' : interrupted.name)
    // A session cut off mid-break: the time since it was cut off is break too.
    void handleStart(interrupted.startedAt, pausedUntil(pauseOf(interrupted), Date.now()))
  }

  // Keeps the time up to the last heartbeat, without a clip.
  async function handleSaveInterrupted() {
    if (!interrupted) return
    const elapsedMs = studiedMs(interrupted.startedAt, interrupted.lastSeen, pauseOf(interrupted))
    try {
      await saveSession(
        { startedAt: interrupted.startedAt, task: interrupted.name, goalMs: 0, elapsedMs },
        null,
      )
    } catch {
      setError("This session couldn't be saved on this device.")
      return
    }
    clearActive()
    sortIntoSubject()
    setInterrupted(null)
    setNotice(`Saved ${formatStudyTime(elapsedMs)}.`)
    onSessionSaved?.()
  }

  function handleDiscardInterrupted() {
    clearActive()
    setInterrupted(null)
  }

  async function handleStop() {
    if (stoppingRef.current || startedAt === null) return // ignore a double-fire
    stoppingRef.current = true
    const stopAt = Date.now()
    setStoppedAt(stopAt) // freezes the stopwatch on the final time
    setStatus('encoding')
    // Every step below is allowed to fail, but none may leave Stop hanging:
    // the study time is what matters most, the clip comes second.
    const ended = await end().catch((e: unknown) => ({
      clip: null,
      problem: `Recording failed: ${describe(e)}`,
      layout: [],
    }))
    let { clip: recorded, problem } = ended
    const { layout } = ended
    const meta = { startedAt, task, goalMs: 0, elapsedMs: studiedMs(startedAt, stopAt, pause) }
    let saved = false
    try {
      // The layout travels with the clip: focus analysis reads it.
      await saveSession(
        recorded && recorded.size > 0 ? { ...meta, layout } : meta,
        recorded && recorded.size > 0 ? recorded : null,
      )
      saved = true
    } catch (e) {
      console.error('saving session with clip failed', e)
      if (recorded && recorded.size > 0) {
        problem = `The browser wouldn't store the video (${describe(e)}).`
        recorded = null
        try {
          await saveSession(meta, null)
          saved = true
        } catch (retryError) {
          console.error('saving session failed', retryError)
        }
      }
    }

    if (saved) sortIntoSubject()
    const validClip = saved && recorded && recorded.size > 0 ? recorded : null
    if (saved) {
      clearActive()
      setUploadingFor(startedAt)
      void Promise.resolve(onSessionSaved?.()).finally(() =>
        setUploadingFor((s) => (s === startedAt ? null : s)),
      )
    }
    setClip(validClip)
    if (!saved) {
      setError("This session couldn't be saved on this device.")
    } else if (!validClip) {
      // The time still counts; say why there's no video rather than leave it out.
      setError(`Your session was saved without a timelapse. ${problem ?? ''}`.trim())
    }
    setStatus('done')
  }

  function handlePause() {
    setRecorderPaused(true)
    setPause((p) => ({ ...p, pausedAt: Date.now() }))
  }

  function handleUnpause() {
    setRecorderPaused(false)
    const now = Date.now()
    setPause((p) => ({ pausedMs: pausedUntil(p, now), pausedAt: null }))
    setStretchFrom(now)
  }

  // Your lamp on the table is the pause switch.
  const lampSwitch = status === 'running' ? (paused ? handleUnpause : handlePause) : undefined
  const lampLabel = paused ? 'Resume' : 'Take a break'

  function handleNewSession() {
    setStartedAt(null)
    setStoppedAt(null)
    setPause(NOT_PAUSED)
    setStretchFrom(null)
    setNotice(null)
    setClip(null)
    setError(null)
    setName('')
    stoppingRef.current = false
    setStatus('idle')
  }

  function handleDownload() {
    if (clip) downloadBlob(clip, timelapseName(clip, task))
  }

  return (
    // Switch to the focus layout only once the feed is live. Keying it to
    // inProgress would flip it during 'starting', while the permission
    // prompts are still up, sizing things for a camera that isn't there yet.
    <section className="session" data-focus={streaming}>
      {/* Camera-only preview. The screen is recorded but never shown — a live
          preview of your own screen reflects itself forever. Shown whenever
          the feeds are live (running + encoding). */}
      {streaming && (
        <div className="session-stage" data-ipad={ipadStream !== null}>
          <video
            ref={faceVideoRef}
            className="session-face"
            autoPlay
            playsInline
            muted
          />
          {/* Below the face: you look down at the iPad. */}
          {ipadStream && (
            <div className="session-ipad-wrap">
              <StreamPreview stream={ipadStream} className="session-ipad" />
              <button
                type="button"
                className="session-ipad-remove"
                aria-label="Remove iPad"
                title="Remove iPad"
                onClick={removeIpad}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}

      <div className="session-clock">
        <input
          className="session-name"
          aria-label="Session name"
          placeholder={status === 'idle' ? 'Name this session' : DEFAULT_SESSION_NAME}
          maxLength={SESSION_NAME_MAX}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          readOnly={status === 'encoding' || status === 'done'}
        />
        <Stopwatch startedAt={startedAt} stoppedAt={stoppedAt} pause={pause} />
      </div>

      <div className="session-actions" data-still={still}>
        {status === 'idle' && (
          <button type="button" className="session-start" onClick={() => handleStart()}>
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

        {/* A second share for one window (QuickTime mirroring the iPad). Its own
            click, since the picker needs a fresh user gesture. */}
        {status === 'running' && !ipadStream && (
          <button type="button" className="session-link" onClick={() => void addIpad()}>
            Add iPad
          </button>
        )}

        {/* The page's own URL works too; this is for when the nav is hidden. */}
        {status === 'running' && inRoom && (
          <button type="button" className="session-link" onClick={handleCopyLink}>
            {linkCopied ? 'Link copied' : 'Copy invite link'}
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

      {status === 'idle' && room && !inRoom && (
        <RoomInvite code={room} onDismiss={() => onRoomChange(null)} />
      )}

      {status === 'idle' && interrupted && (
        <div className="session-recover" role="status">
          <p>
            “{interrupted.name}” was cut off after{' '}
            {formatStudyTime(
              studiedMs(interrupted.startedAt, interrupted.lastSeen, pauseOf(interrupted)),
            )}. Its
            timelapse couldn't be kept.
          </p>
          <div className="session-recover-actions">
            {Date.now() - interrupted.lastSeen < RESUME_WINDOW_MS && (
              <button type="button" className="session-stop" onClick={handleResume}>
                Resume
              </button>
            )}
            <button type="button" className="session-stop" onClick={handleSaveInterrupted}>
              Save the time
            </button>
            <button type="button" className="session-link" onClick={handleDiscardInterrupted}>
              Discard
            </button>
          </div>
        </div>
      )}

      {notice && <p className="session-notice" role="status">{notice}</p>}
      {error && <p className="error">{error}</p>}

      {inRoom && room ? (
        <RoomPanel
          code={room}
          studyingSince={status === 'running' && !paused ? stretchFrom : null}
          onLamp={lampSwitch}
          lampLabel={lampLabel}
        />
      ) : (
        status === 'running' && (
          <SoloTable studying={!paused} onLamp={lampSwitch} lampLabel={lampLabel} />
        )
      )}
    </section>
  )
}

// Plays a live stream in a <video>. srcObject can't be set as a JSX prop, so it's
// attached after mount. One stream can feed several <video>s at once, so this
// preview doesn't disturb the hidden copy the timelapse samples from.
//
// The tile takes the stream's own shape (read once frames arrive, and again if
// the shared window is resized), so the picture fills it with no black bars.
function StreamPreview({ stream, className }: { stream: MediaStream; className: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [aspect, setAspect] = useState<number | null>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    const measure = () => {
      if (video.videoWidth) setAspect(video.videoWidth / video.videoHeight)
    }
    video.addEventListener('loadedmetadata', measure)
    video.addEventListener('resize', measure)
    video.srcObject = stream
    void video.play().catch(() => {})
    return () => {
      video.removeEventListener('loadedmetadata', measure)
      video.removeEventListener('resize', measure)
      video.srcObject = null
    }
  }, [stream])
  return (
    <video
      ref={ref}
      className={className}
      style={aspect ? { aspectRatio: String(aspect) } : undefined}
      autoPlay
      playsInline
      muted
    />
  )
}
