import { useEffect, useState } from 'react'
import StudyTable, { type TablePerson } from './StudyTable'
import { useMe } from './useMe'
import { usePersonPeek } from './useRoom'

// Where the table goes when someone's ?with= link brought you here. While
// they're studying: their table as it is, with your empty seat at it, and
// that Enter joins them. No sign-in needed: signed out, you join as a guest.
// Says nothing for your own link, or a table you're already at (a refresh).
export default function RoomInvite({ username, onDismiss }: { username: string; onDismiss: () => void }) {
  const peek = usePersonPeek(username)
  const me = useMe()
  const [signedIn, setSignedIn] = useState<boolean | null>(null)

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

  async function handleSignIn() {
    try {
      const { signIn } = await import('../compete/api')
      await signIn('timer')
    } catch (err) {
      console.error('sign in failed', err)
    }
  }

  if (peek === undefined || signedIn === null || peek?.isMe || peek?.joined) return null

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

  const people: TablePerson[] = [
    { id: 'me', name: me.name, avatar: me.avatar, lit: false },
    ...peek.people.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, lit: p.live })),
  ]

  return (
    <>
      <div className="session-recover" role="status">
        <p>Press Enter to study with {peek.name}.</p>
        {!signedIn && (
          <p className="room-guest-note">
            This session won't be saved.{' '}
            <button type="button" className="session-link" onClick={handleSignIn}>
              Sign in
            </button>
          </p>
        )}
        <div className="session-recover-actions">
          <button type="button" className="session-link" onClick={onDismiss}>
            Study alone
          </button>
        </div>
      </div>
      <StudyTable people={people} />
    </>
  )
}
