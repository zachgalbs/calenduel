import { useEffect, useState } from 'react'
import type { RoomPreview } from '../compete/api'
import Members from './Members'
import { roomLink, useNow, useRoom } from './useRoom'
import './Room.css'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`
}

type Props = { code: string; onStudy: () => void; onLeave: () => void }

// The lobby of a group study: copy the link, watch people arrive, and (host)
// start it. Once started, everyone gets a Start studying button: each person's
// own click, since the browser only lets a click share a screen.
function LobbyRoom({ code, myId, onStudy, onLeave }: Props & { myId: string }) {
  const { state, error, beatFailing } = useRoom(code, null)
  const [copied, setCopied] = useState(false)
  const [starting, setStarting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const live = state?.members.some((m) => m.liveSince !== null) ?? false
  const now = useNow(live)

  const me = state?.members.find((m) => m.id === myId)
  const isHost = me?.isHost ?? false
  const here = state?.members.filter((m) => m.here).length ?? 0
  const started = state?.startedAt != null

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(roomLink(code))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setActionError(`Couldn't copy it. The link is ${roomLink(code)}`)
    }
  }

  async function handleStart() {
    setActionError(null)
    setStarting(true)
    try {
      const { startRoom } = await import('../compete/api')
      await startRoom(code)
      onStudy() // the host starts studying with the same click
    } catch (err) {
      setActionError(errorText(err))
      setStarting(false)
    }
  }

  async function handleLeave() {
    try {
      const { leaveRoom } = await import('../compete/api')
      await leaveRoom(code)
    } catch {
      // Leaving locally still works; the room shows you as away soon after.
    }
    onLeave()
  }

  return (
    <section className="room">
      <header className="room-head">
        <div>
          <h1 className="room-title">Group study</h1>
          {state && (
            <p className="room-sub">
              {isHost ? 'You’re hosting' : `Hosted by ${state.hostName}`}
            </p>
          )}
        </div>
        <span className={here > 0 ? 'room-live on' : 'room-live'}>
          <span className="room-live-dot" aria-hidden="true" />
          {plural(here, 'person', 'people')} here
        </span>
      </header>

      {!started && (
        <div className="room-invite">
          <p className="room-invite-label">Invite people with this link</p>
          <div className="room-invite-row">
            <code className="room-invite-link">{roomLink(code).replace(/^https?:\/\//, '')}</code>
            <button type="button" className="room-btn" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </div>
      )}

      {state === null && !error && <p className="room-note">Loading...</p>}
      {state && <Members members={state.members} myId={myId} now={now} />}

      <div className="room-cta">
        {!started && isHost && (
          <>
            <button
              type="button"
              className="room-btn big primary"
              onClick={handleStart}
              disabled={starting}
            >
              {starting ? 'Starting...' : 'Start group study'}
            </button>
            <p className="room-note">
              Everyone here gets a button to start studying. People can still join
              with the link after it starts.
            </p>
          </>
        )}
        {!started && !isHost && state && (
          <p className="room-waiting">
            <span className="room-waiting-dot" aria-hidden="true" />
            Waiting for {state.hostName} to start
          </p>
        )}
        {started && (
          <>
            <button type="button" className="room-btn big primary" onClick={onStudy}>
              Start studying
            </button>
            {!isHost && (
              <p className="room-note">{state?.hostName} started the group study.</p>
            )}
          </>
        )}
      </div>

      <div className="room-foot">
        {started && (
          <button type="button" className="room-link" onClick={handleCopy}>
            {copied ? 'Link copied' : 'Copy invite link'}
          </button>
        )}
        <button type="button" className="room-link" onClick={handleLeave}>
          Leave group study
        </button>
      </div>

      {beatFailing && !error && (
        <p className="room-error" role="alert">
          Can't reach the group study, so the others may not see you. Check your connection.
        </p>
      )}
      {(error || actionError) && (
        <p className="room-error" role="alert">{actionError ?? error}</p>
      )}
    </section>
  )
}

// What a group study link opens. Signs you in and joins you first if needed.
export default function Lobby({ code, onStudy, onLeave }: Props) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [myId, setMyId] = useState<string | null>(null)
  const [preview, setPreview] = useState<RoomPreview | null | undefined>(undefined)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let closed = false
    ;(async () => {
      const api = await import('../compete/api')
      const active = await api.isSignedIn()
      if (closed) return
      setSignedIn(active)
      if (!active) return
      const [profile, p] = await Promise.all([api.ensureProfile(), api.roomPreview(code)])
      if (closed) return
      setMyId(profile.id)
      setPreview(p)
    })().catch((err) => {
      if (!closed) setError(errorText(err))
    })
    return () => {
      closed = true
    }
  }, [code])

  async function handleJoin() {
    setError(null)
    setJoining(true)
    try {
      const { joinRoom, roomPreview } = await import('../compete/api')
      await joinRoom(code)
      setPreview(await roomPreview(code))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setJoining(false)
    }
  }

  async function handleSignIn() {
    try {
      const { signIn } = await import('../compete/api')
      await signIn('room')
    } catch (err) {
      setError(errorText(err))
    }
  }

  if (signedIn && preview?.joined && myId) {
    return (
      <main className="room-page">
        <LobbyRoom code={code} myId={myId} onStudy={onStudy} onLeave={onLeave} />
      </main>
    )
  }

  return (
    <main className="room-page">
      <section className="room">
        <h1 className="room-title">Group study</h1>

        {signedIn === null && !error && <p className="room-note">Loading...</p>}

        {signedIn === false && (
          <>
            <p className="room-lead">Sign in to join this group study.</p>
            <button type="button" className="room-btn big primary" onClick={handleSignIn}>
              Sign in with Google
            </button>
          </>
        )}

        {signedIn && preview === null && (
          <p className="room-lead">This group study link doesn't match any group study.</p>
        )}

        {signedIn && preview && !preview.joined && preview.expired && (
          <p className="room-lead">
            {preview.hostName}'s group study has ended. Ask for a new link.
          </p>
        )}

        {signedIn && preview && !preview.joined && !preview.expired && (
          <>
            <p className="room-lead">
              {preview.hostName} invited you to study together
              {preview.started ? '. It’s already going.' : '.'}
            </p>
            <p className="room-note">
              {plural(preview.members, 'person', 'people')} in it so far. You'll see
              when each other are studying and for how long, never what. Joining
              also adds everyone as friends on Compete.
            </p>
            <div className="room-cta">
              <button
                type="button"
                className="room-btn big primary"
                onClick={handleJoin}
                disabled={joining}
              >
                {joining ? 'Joining...' : 'Join group study'}
              </button>
            </div>
            <div className="room-foot">
              <button type="button" className="room-link" onClick={onLeave}>
                Not now
              </button>
            </div>
          </>
        )}

        {error && <p className="room-error" role="alert">{error}</p>}
      </section>
    </main>
  )
}
