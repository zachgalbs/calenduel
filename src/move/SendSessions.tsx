import { useEffect, useState } from 'react'
import { getClip, listSessions, type SessionMeta } from '../db'
import { helperEnabled } from '../media/ipadHelper'
import { savedSubjects } from '../subjects/sort'
import { doneMessage, partnerOrigin, readMessage, sessionMessage, settingsMessage } from './move'
import './Move.css'

// A large recording takes a while to copy; past this, the other page is gone.
const ACK_TIMEOUT_MS = 120_000

// Resolves when the page that asked says it has saved this session.
function saved(from: Window, origin: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== from) return
      const msg = readMessage(e.data)
      if (msg?.kind !== 'ack' || msg.id !== id) return
      done()
      resolve()
    }
    const timer = setTimeout(() => {
      done()
      reject(new Error('the other page stopped answering'))
    }, ACK_TIMEOUT_MS)
    window.addEventListener('message', onMessage)
  })
}

// The whole page of the small window opened by BringOver at the app's other
// address. It sends this address's sessions to that page, and only after a
// click here. Everything is posted to the partner origin and nowhere else, so
// a different site that opens this window receives nothing.
export default function SendSessions() {
  const partner = partnerOrigin()
  const opener = window.opener as Window | null
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [state, setState] = useState<'ready' | 'sending' | 'sent' | 'failed'>('ready')
  const [sent, setSent] = useState(0)

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
  }, [])

  const here = window.location.host
  const there = partner ? new URL(partner).host : null

  async function send() {
    if (!partner || !opener || !sessions) return
    setState('sending')
    try {
      for (const meta of sessions) {
        const clip = meta.hasClip ? await getClip(meta.id) : null
        const landed = saved(opener, partner, meta.id)
        opener.postMessage(sessionMessage(meta, clip), partner)
        await landed
        setSent((n) => n + 1)
      }
      opener.postMessage(settingsMessage(savedSubjects(), helperEnabled()), partner)
      opener.postMessage(doneMessage(), partner)
      setState('sent')
    } catch (err) {
      console.error('sending sessions failed', err)
      setState('failed')
    }
  }

  let body
  if (!partner || !opener || !there) {
    body = <p>Open this from Sessions at the app's other address.</p>
  } else if (sessions === null) {
    body = null
  } else if (sessions.length === 0) {
    body = <p>No sessions saved at {here}.</p>
  } else if (state === 'sent') {
    body = <p>Sent. You can close this window.</p>
  } else if (state === 'sending') {
    body = (
      <p>
        Sending {sent} of {sessions.length}… Keep this window open.
      </p>
    )
  } else {
    body = (
      <>
        <p>
          {state === 'failed'
            ? `That didn't finish. Keep the ${there} tab open and try again.`
            : `Send ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} from ${here} to ${there}?`}
        </p>
        <button type="button" className="move-send" onClick={() => void send()}>
          {state === 'failed' ? 'Try again' : 'Send'}
        </button>
        <p className="move-note">Recordings included. They stay here too.</p>
      </>
    )
  }

  return (
    <main className="move-page" role="status">
      {body}
    </main>
  )
}
