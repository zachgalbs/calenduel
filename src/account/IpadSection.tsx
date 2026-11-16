import { useCallback, useEffect, useState } from 'react'
import QRCode from 'react-qr-code'
import { isSignedIn } from '../compete/api'
import { pairIpad, relayStatus, unpairIpad, type RelayStatus } from '../media/ipadRelay'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

// Pairs the Calenduel Link iPad app with this account: a QR code the iPad's
// Camera scans. After that, starting a broadcast on the iPad puts it in your
// sessions on any computer you're signed in on. Loaded on demand (it imports the
// auth SDK), like ProfileSection.
export default function IpadSection() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [status, setStatus] = useState<RelayStatus | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await relayStatus())
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    let closed = false
    isSignedIn()
      .then((active) => {
        if (closed) return
        setSignedIn(active)
        if (active) void refresh()
      })
      .catch((err) => {
        if (!closed) setError(errorText(err))
      })
    return () => {
      closed = true
    }
  }, [refresh])

  // While the code is up, watch for the iPad to use it, then put the code away.
  useEffect(() => {
    if (!link) return
    const timer = setInterval(async () => {
      try {
        const next = await relayStatus()
        setStatus(next)
        if (next.seen) setLink(null)
      } catch {
        // Keep showing the code; the next tick tries again.
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [link])

  async function run(action: () => Promise<void>) {
    setError(null)
    setBusy(true)
    try {
      await action()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const pair = () =>
    run(async () => {
      setLink(await pairIpad())
      setStatus((s) => (s ? { ...s, paired: true, seen: false, connected: false } : s))
    })
  const unpair = () =>
    run(async () => {
      await unpairIpad()
      setLink(null)
      await refresh()
    })

  const paired = status?.paired && status.seen

  return (
    <section className="account-section">
      <h2>iPad</h2>

      {signedIn === false && (
        <p className="account-note">Sign in on the Compete tab to connect an iPad.</p>
      )}

      {signedIn && !link && (
        <>
          <p className="account-note">
            {paired
              ? status.connected
                ? 'Your iPad is sharing its screen. It joins your next session on its own.'
                : 'Your iPad is connected. Start sharing in Calenduel Link and it joins your sessions, no cable needed.'
              : 'Put your iPad in your sessions without a cable, using the Calenduel Link app.'}
          </p>
          <div className="profile-actions">
            <button type="button" className="account-btn" onClick={pair} disabled={busy}>
              {paired ? 'Connect a different iPad' : 'Connect an iPad'}
            </button>
            {status?.paired && (
              <button type="button" className="account-btn" onClick={unpair} disabled={busy}>
                Disconnect iPad
              </button>
            )}
          </div>
        </>
      )}

      {signedIn && link && (
        <div className="ipad-pair">
          <div className="ipad-qr">
            <QRCode value={link} size={176} />
          </div>
          <ol className="ipad-steps">
            <li>
              Install <strong>Calenduel Link</strong> from the App Store on your iPad.
            </li>
            <li>Point the iPad's Camera at this code and tap the link.</li>
          </ol>
          <button type="button" className="account-btn" onClick={() => setLink(null)}>
            Cancel
          </button>
        </div>
      )}

      {error && <p className="account-error">{error}</p>}
    </section>
  )
}
