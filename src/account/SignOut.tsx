import { useEffect, useState } from 'react'
import { isSignedIn, signOut } from '../compete/api'

// The last thing on Account. Signing out reloads, so every page forgets you.
export default function SignOut() {
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => {
    let closed = false
    isSignedIn()
      .then((active) => {
        if (!closed) setSignedIn(active)
      })
      .catch(() => {})
    return () => {
      closed = true
    }
  }, [])
  if (!signedIn) return null
  return (
    <section className="account-section">
      <button
        type="button"
        className="account-link"
        onClick={() => {
          signOut()
            .then(() => window.location.reload())
            .catch((err) => console.error('sign out failed', err))
        }}
      >
        Sign out
      </button>
    </section>
  )
}
