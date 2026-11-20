import { useEffect, useState } from 'react'
import RoomPanel from './RoomPanel'
import { guestSecret } from './guest'
import { usePersonPeek, type Seat } from './useRoom'

// Where the table goes when someone's ?with= link brought you here. While
// they're studying you sit straight down at their table, lamp off until you
// start, so they see you've arrived. Signed out, you sit as a guest.
export default function RoomInvite({ username }: { username: string }) {
  const peek = usePersonPeek(username)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [seat, setSeat] = useState<Seat | null>(null)
  const room = peek && !peek.isMe ? peek.room : null

  useEffect(() => {
    let closed = false
    import('../compete/api')
      .then((api) => api.isSignedIn())
      .then((active) => {
        if (!closed) setSignedIn(active)
      })
      .catch(() => {})
    return () => {
      closed = true
    }
  }, [])

  // Take a seat at their table as soon as there is one. Not left on the way
  // out: starting carries on in this same seat, and an abandoned one fades
  // after 90 s without a beat.
  useEffect(() => {
    if (!room || signedIn === null) return
    let closed = false
    ;(async () => {
      const api = await import('../compete/api')
      if (signedIn) {
        const me = (await api.ensureProfile()).id
        await api.joinRoom(room)
        if (!closed) setSeat({ room, selfId: me, guest: false })
      } else {
        const id = await api.guestJoin(room, guestSecret())
        if (!closed) setSeat({ room, selfId: id, guest: true })
      }
    })().catch((err) => console.error('sitting down at the study table failed', err))
    return () => {
      closed = true
    }
  }, [room, signedIn])

  async function handleSignIn() {
    try {
      const { signIn } = await import('../compete/api')
      await signIn('timer')
    } catch (err) {
      console.error('sign in failed', err)
    }
  }

  if (peek === undefined || signedIn === null || peek?.isMe) return null

  if (peek === null) {
    return (
      <p className="session-notice" role="status">
        No one goes by {username}.
      </p>
    )
  }

  if (!peek.room) {
    return (
      <p className="session-notice" role="status">
        {peek.name} isn't studying.
      </p>
    )
  }

  return (
    <>
      {!signedIn && (
        <p className="room-guest-note" role="status">
          Saved on this device only.{' '}
          <button type="button" className="session-link" onClick={handleSignIn}>
            Sign in
          </button>
        </p>
      )}
      {seat?.room === peek.room && (
        <RoomPanel code={seat.room} selfId={seat.selfId} guest={seat.guest} studyingSince={null} />
      )}
    </>
  )
}
