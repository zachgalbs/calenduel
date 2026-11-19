import { useEffect, useState } from 'react'
import type { RoomPreview } from '../compete/api'

// Under the Start button when a study room link brought you here: whose room
// it is, and that pressing Start joins it. Says nothing for a room you're
// already in (a refresh), since Start just carries on there.
export default function RoomInvite({ code, onDismiss }: { code: string; onDismiss: () => void }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  // undefined = still loading; null = no room has this code.
  const [preview, setPreview] = useState<RoomPreview | null | undefined>(undefined)

  useEffect(() => {
    let closed = false
    ;(async () => {
      const api = await import('../compete/api')
      const active = await api.isSignedIn()
      if (closed) return
      setSignedIn(active)
      if (!active) return
      const p = await api.roomPreview(code)
      if (!closed) setPreview(p)
    })().catch((err) => {
      console.error('study room preview failed', err)
      if (!closed) setPreview(null)
    })
    return () => {
      closed = true
    }
  }, [code])

  async function handleSignIn() {
    try {
      const { signIn } = await import('../compete/api')
      await signIn('timer')
    } catch (err) {
      console.error('sign in failed', err)
    }
  }

  if (signedIn === null) return null

  if (!signedIn) {
    return (
      <div className="session-recover" role="status">
        <p>You've been invited to study together. Sign in to join.</p>
        <div className="session-recover-actions">
          <button type="button" className="session-stop" onClick={handleSignIn}>
            Sign in with Google
          </button>
          <button type="button" className="session-link" onClick={onDismiss}>
            Study alone
          </button>
        </div>
      </div>
    )
  }

  if (preview === undefined || preview?.joined) return null

  if (preview === null || preview.expired) {
    return (
      <p className="session-notice" role="status">
        That study link has expired. Start studies on your own.
      </p>
    )
  }

  const others = preview.members - 1
  return (
    <div className="session-recover" role="status">
      <p>
        Press Start to study with {preview.hostName}
        {others > 0 ? ` and ${others} ${others === 1 ? 'other' : 'others'}` : ''}. You'll
        see when each other are studying and for how long, never what. Joining also
        adds everyone in it as friends on Compete.
      </p>
      <div className="session-recover-actions">
        <button type="button" className="session-link" onClick={onDismiss}>
          Study alone instead
        </button>
      </div>
    </div>
  )
}
