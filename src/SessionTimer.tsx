import { useEffect, useRef, useState } from 'react'
import { useLiveBeat } from './compete/useLiveBeat'
import Stopwatch from './Stopwatch'
import { useTimelapseRecorder } from './session/useTimelapseRecorder'
import { downloadBlob, timelapseName } from './media/share'
import { DEFAULT_SESSION_NAME, SESSION_NAME_MAX, saveSession } from './db'
import { formatStudyTime, localDay } from './compete/stats'
import { clearStash, loadStash } from './media/frameStash'
import { finishStash } from './media/timelapse'
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
import { guestSecret } from './room/guest'
import { ExpandIcon, PlusIcon, ShrinkIcon, XIcon } from './icons'
import { saveSeat, savedSeat, type Seat } from './room/useRoom'
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

type Api = typeof import('./compete/api')

// How often a session started from someone's link looks for them.
const LINK_CHECK_MS = 5_000

export default function SessionTimer({
  withUser = null,
  joinCode = null,
  onJoined,
  onRoomChange,
  autoStart = false,
  onAutoStarted,
  onActiveChange,
  onSessionSaved,
}: {
  // Whose ?with= link brought us here: Enter studies at their table.
  withUser?: string | null
  // A friend's room from a Join click on Friends: the next start joins it.
  joinCode?: string | null
  onJoined?: () => void
  // The room this tab sits in, so Friends can leave out its Join button.
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
  // Where this session's timelapse frames are kept, so a refresh can't lose them.
  const [stashId, setStashId] = useState<string | null>(null)
  // Save on a cut-off session is building its clip.
  const [rescuing, setRescuing] = useState(false)
  // The room this session sits in, and how: signed in, or as a guest. Kept
  // through a refresh (sessionStorage), so resuming finds the same table.
  const [seat, setSeat] = useState<Seat | null>(savedSeat)
  // The room the last session left, so the next can rejoin it if the others
  // are still at it.
  const lastSeatRef = useRef<Seat | null>(null)
  useEffect(() => {
    saveSeat(seat)
    onRoomChange(seat?.room ?? null)
  }, [seat, onRoomChange])
  const still = useStill(status === 'running')
  const [clip, setClip] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Optional, and never required to start: Enter starts with or without it. It can be
  // typed before or during the session, and is fixed once Stop is pressed
  // (after that, rename it on the Sessions page).
  const [name, setName] = useState('')
  const task = name.trim() || DEFAULT_SESSION_NAME
  // A session cut off by a refresh or a closed tab, read once on load.
  const [interrupted, setInterrupted] = useState<ActiveSession | null>(() =>
    interruptedSession(Date.now()),
  )
  const [notice, setNotice] = useState<string | null>(null)
  // The iPad blown up to fill most of the screen (for screenshots). Remembered.
  const [bigIpad, setBigIpad] = useState(() => {
    try {
      return localStorage.getItem(BIG_IPAD_KEY) === '1'
    } catch {
      return false
    }
  })
  function toggleBigIpad() {
    const big = !bigIpad
    setBigIpad(big)
    try {
      localStorage.setItem(BIG_IPAD_KEY, big ? '1' : '0')
    } catch {
      // Storage blocked: it just isn't remembered.
    }
  }

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
          room: status === 'running' && seat && !seat.guest ? seat.room : null,
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
        stash: stashId ?? undefined,
      })
    beat()
    const timer = setInterval(beat, HEARTBEAT_MS)
    window.addEventListener('pagehide', beat)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', beat)
    }
  }, [status, startedAt, task, pause, stashId])

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
  // lapsed, the picker refuses and Enter in the name starts it instead.
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
  // resumeFrom carries on an interrupted session from its original start, and
  // resumeStash its timelapse.
  async function handleStart(resumeFrom?: number, pausedBefore = 0, resumeStash?: string) {
    setError(null)
    setNotice(null)
    setStatus('starting')
    try {
      setStashId(await begin(resumeStash))
      // A fresh start sets the cut-off session aside for good.
      if (resumeFrom === undefined && interrupted?.stash) void clearStash(interrupted.stash)
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
  // Signed out, you can still sit at someone's table from their link, as a
  // guest. In the background: the session is already running, and a room
  // that can't be reached just means studying alone. In order:
  //   - A friend's room from a Join click.
  //   - The room of whoever's ?with= link brought us here, if they're in one.
  //   - The room this tab was in (a refresh, or the last session), if
  //     someone else is still studying in it.
  //   - A new room of your own (signed in only; a guest studies alone).
  function enterRoom() {
    const previous = seat ?? lastSeatRef.current
    const clicked = joinCode
    if (clicked) onJoined?.()
    void (async () => {
      const api = await import('./compete/api')
      const signedIn = await api.isSignedIn()
      const me = signedIn ? (await api.ensureProfile()).id : null
      const secret = signedIn ? null : guestSecret()

      let target: string | null = clicked
      if (!target && withUser) {
        const person = await api.personPeek(withUser, secret).catch(() => null)
        if (person && !person.isMe) target = person.room
      }
      if (!target && previous && previous.guest === !me) {
        const people = await api.roomPeek(previous.room).catch(() => null)
        if (people?.some((p) => p.id !== previous.selfId && p.live)) target = previous.room
      }

      if (target) {
        try {
          await sitAt(api, target, me)
          return
        } catch (err) {
          console.error('joining the study room failed', err)
        }
      }
      if (!me) {
        setSeat(null)
        return
      }
      setSeat({ room: await api.createRoom(), selfId: me, guest: false })
    })().catch((err) => console.error('study room failed', err))
  }

  // Joins a room and takes a seat at its table: signed in (me = your id),
  // or as a guest.
  async function sitAt(api: Api, target: string, me: string | null) {
    if (me) {
      await api.joinRoom(target) // idempotent; also friends you with everyone in it
      setSeat({ room: target, selfId: me, guest: false })
    } else {
      const id = await api.guestJoin(target, guestSecret())
      setSeat({ room: target, selfId: id, guest: true })
    }
  }

  // Studying from someone's link before they've started: keep an eye out,
  // and move to their table once they're at it. Unless someone's already
  // sitting with you: then you stay put.
  const seatRef = useRef(seat)
  useEffect(() => {
    seatRef.current = seat
  })
  useEffect(() => {
    if (status !== 'running' || !withUser) return
    let closed = false
    const check = async () => {
      const api = await import('./compete/api')
      const signedIn = await api.isSignedIn()
      const person = await api.personPeek(withUser, signedIn ? null : guestSecret())
      const current = seatRef.current
      if (closed || !person || person.isMe || !person.room || person.room === current?.room) return
      if (current) {
        const people = await api.roomPeek(current.room)
        if (closed || people?.some((p) => p.id !== current.selfId)) return
        await (current.guest ? api.guestLeave(current.room, guestSecret()) : api.leaveRoom(current.room))
      }
      await sitAt(api, person.room, signedIn ? (await api.ensureProfile()).id : null)
    }
    const timer = setInterval(() => {
      check().catch((err) => console.error('following the study link failed', err))
    }, LINK_CHECK_MS)
    return () => {
      closed = true
      clearInterval(timer)
    }
  }, [status, withUser])

  // Stopping leaves the table: the others see you go, not a dark lamp (a
  // break keeps you seated), and the last one out disbands the room.
  function leaveRoom() {
    if (!seat) return
    const { room: code, guest } = seat
    lastSeatRef.current = seat
    setSeat(null)
    void import('./compete/api')
      .then((api) => (guest ? api.guestLeave(code, guestSecret()) : api.leaveRoom(code)))
      .catch((err) => console.error('leaving the study room failed', err))
  }

  function handleResume() {
    if (!interrupted) return
    setName(interrupted.name === DEFAULT_SESSION_NAME ? '' : interrupted.name)
    // A session cut off mid-break: the time since it was cut off is break too.
    void handleStart(
      interrupted.startedAt,
      pausedUntil(pauseOf(interrupted), Date.now()),
      interrupted.stash,
    )
  }

  // Keeps the time up to the last heartbeat, with the timelapse frames kept
  // until the cut-off.
  async function handleSaveInterrupted() {
    if (!interrupted || rescuing) return
    setRescuing(true)
    const elapsedMs = studiedMs(interrupted.startedAt, interrupted.lastSeen, pauseOf(interrupted))
    const meta = { startedAt: interrupted.startedAt, task: interrupted.name, goalMs: 0, elapsedMs }
    const kept = interrupted.stash ? await loadStash(interrupted.stash) : null
    const { clip, layout } = kept
      ? await finishStash(kept).catch(() => ({ clip: null, layout: [] }))
      : { clip: null, layout: [] }
    try {
      try {
        await saveSession(clip && clip.size > 0 ? { ...meta, layout } : meta, clip)
      } catch (e) {
        if (!clip) throw e
        console.error('saving the rescued clip failed', e)
        await saveSession(meta, null) // the time, at least
      }
    } catch {
      setError("This session couldn't be saved on this device.")
      setRescuing(false)
      return
    }
    setRescuing(false)
    if (interrupted.stash) void clearStash(interrupted.stash)
    clearActive()
    sortIntoSubject()
    setInterrupted(null)
    setNotice(`Saved ${formatStudyTime(elapsedMs)}.`)
    onSessionSaved?.()
  }

  function handleDiscardInterrupted() {
    if (interrupted?.stash) void clearStash(interrupted.stash)
    clearActive()
    setInterrupted(null)
  }

  async function handleStop() {
    if (stoppingRef.current || startedAt === null) return // ignore a double-fire
    stoppingRef.current = true
    const stopAt = Date.now()
    setStoppedAt(stopAt) // freezes the stopwatch on the final time
    setStatus('encoding')
    leaveRoom()
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
      void clearStash(stashId)
      setStashId(null)
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

  const ipadTile = ipadStream && (
    <div className="session-ipad-wrap" data-big={bigIpad}>
      <StreamPreview stream={ipadStream} className="session-ipad" />
      <div className="session-ipad-tools">
        <button
          type="button"
          className="session-ipad-tool"
          aria-label={bigIpad ? 'Shrink iPad' : 'Enlarge iPad'}
          title={bigIpad ? 'Shrink iPad' : 'Enlarge iPad'}
          onClick={toggleBigIpad}
        >
          {bigIpad ? <ShrinkIcon /> : <ExpandIcon />}
        </button>
        <button
          type="button"
          className="session-ipad-tool"
          aria-label="Remove iPad"
          title="Remove iPad"
          onClick={removeIpad}
        >
          <XIcon />
        </button>
      </div>
    </div>
  )

  return (
    // Switch to the focus layout only once the feed is live. Keying it to
    // inProgress would flip it during 'starting', while the permission
    // prompts are still up, sizing things for a camera that isn't there yet.
    <section className="session" data-focus={streaming}>
      {/* Camera-only preview. The screen is recorded but never shown — a live
          preview of your own screen reflects itself forever. Shown whenever
          the feeds are live (running + encoding). */}
      {/* Big: the iPad fills most of the screen, the camera stays in its corner. */}
      {streaming && bigIpad && ipadTile}
      {streaming && (
        <div className="session-stage reveal" data-ipad={ipadStream !== null && !bigIpad}>
          <video
            ref={faceVideoRef}
            className="session-face"
            autoPlay
            playsInline
            muted
          />
          {/* A second share for one window (QuickTime mirroring the iPad). Its
              own click, since the picker needs a fresh user gesture. */}
          {status === 'running' && !ipadStream && (
            <button
              type="button"
              className="session-ipad-add reveal-item"
              aria-label="Add iPad"
              title="Add iPad"
              onClick={() => void addIpad()}
            >
              <PlusIcon />
            </button>
          )}
          {/* Below the face: you look down at the iPad. */}
          {!bigIpad && ipadTile}
        </div>
      )}

      <div className="session-clock">
        <div className="session-name-row">
          <input
            className="session-name"
            aria-label="Session name"
            // Ready to type the moment the timer shows: name it, press Enter.
            autoFocus={status === 'idle'}
            placeholder={status === 'idle' ? 'What are you studying?' : DEFAULT_SESSION_NAME}
            maxLength={SESSION_NAME_MAX}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.currentTarget.blur()
              // Name it, press Enter, you're studying. The key press is the
              // gesture the screen picker needs, as a click on Start would be.
              if (status === 'idle') void handleStart()
            }}
            readOnly={status === 'encoding' || status === 'done'}
          />
          {/* The only start control: Enter does it, this is for the mouse. */}
          {status === 'idle' && (
            <button
              type="button"
              className="session-go"
              aria-label="Start"
              title="Start"
              onClick={() => handleStart()}
            >
              ↵
            </button>
          )}
        </div>
        <Stopwatch startedAt={startedAt} stoppedAt={stoppedAt} pause={pause} resumedAt={stretchFrom} />
      </div>

      <div className="session-actions" data-still={still}>
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

      {status === 'idle' && interrupted && (
        <div className="session-recover" role="status">
          <p>
            Cut off after{' '}
            {formatStudyTime(
              studiedMs(interrupted.startedAt, interrupted.lastSeen, pauseOf(interrupted)),
            )}
          </p>
          <div className="session-recover-actions">
            {Date.now() - interrupted.lastSeen < RESUME_WINDOW_MS && (
              <button
                type="button"
                className="session-stop"
                onClick={handleResume}
                disabled={rescuing}
              >
                Resume
              </button>
            )}
            <button
              type="button"
              className="session-stop"
              onClick={handleSaveInterrupted}
              disabled={rescuing}
            >
              {rescuing ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Discard"
              title="Discard"
              onClick={handleDiscardInterrupted}
              disabled={rescuing}
            >
              <XIcon />
            </button>
          </div>
        </div>
      )}

      {notice && <p className="session-notice" role="status">{notice}</p>}
      {error && <p className="error">{error}</p>}

      {status === 'running' &&
        (seat ? (
          <RoomPanel
            code={seat.room}
            selfId={seat.selfId}
            guest={seat.guest}
            studyingSince={paused ? null : stretchFrom}
            onLamp={lampSwitch}
            lampLabel={lampLabel}
          />
        ) : (
          <SoloTable studying={!paused} onLamp={lampSwitch} lampLabel={lampLabel} />
        ))}

      {status === 'idle' && withUser && (
        <RoomInvite username={withUser} />
      )}
    </section>
  )
}

const BIG_IPAD_KEY = 'calenduel.bigIpad'

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
