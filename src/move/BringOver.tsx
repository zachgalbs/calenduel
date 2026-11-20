import { useEffect, useRef, useState } from 'react'
import { importSession } from '../db'
import { enableHelper } from '../media/ipadHelper'
import { notifySubjects, savedSubjects, writeSavedSubjects } from '../subjects/sort'
import { subjectKey } from '../subjects/subjects'
import { SEND_PARAM, ackMessage, partnerOrigin, readMessage } from './move'
import './Move.css'

type State = 'idle' | 'moving' | 'done' | 'blocked' | 'failed'

// One quiet line under Sessions: fetch the sessions this browser saved at the
// app's other address. It opens that address in a small window, which asks
// before sending anything (SendSessions).
export default function BringOver({ onMoved }: { onMoved: () => void }) {
  const partner = partnerOrigin()
  const [state, setState] = useState<State>('idle')
  const [added, setAdded] = useState(0)
  const stopRef = useRef<(() => void) | null>(null)
  useEffect(() => () => stopRef.current?.(), [])

  if (!partner) return null
  const there = new URL(partner).host

  function start() {
    if (!partner) return
    stopRef.current?.()
    // Opened from this click, or the browser blocks it.
    const popup = window.open(`${partner}/?${SEND_PARAM}=1`, 'calenduel-move', 'popup,width=440,height=300')
    if (!popup) {
      setState('blocked')
      return
    }
    setState('moving')
    setAdded(0)
    let count = 0
    // One at a time, in the order sent: each is a write to the database.
    let queue: Promise<void> = Promise.resolve()

    const finish = (next: State) => {
      stop()
      setState(next)
      if (count > 0) onMoved()
    }
    const onMessage = (e: MessageEvent) => {
      // Only the window opened above, and only at the other address.
      if (e.origin !== partner || e.source !== popup) return
      const msg = readMessage(e.data)
      if (!msg) return
      queue = queue
        .then(async () => {
          if (msg.kind === 'session') {
            if (await importSession(msg.meta, msg.clip)) setAdded((count += 1))
            popup.postMessage(ackMessage(msg.meta.id), partner)
          } else if (msg.kind === 'settings') {
            const mine = savedSubjects()
            const known = new Set(mine.map((s) => subjectKey(s.name)))
            const fresh = msg.subjects.filter((s) => !known.has(subjectKey(s.name)))
            if (fresh.length > 0) {
              writeSavedSubjects([...mine, ...fresh])
              notifySubjects()
            }
            if (msg.ipadHelper) enableHelper()
          } else if (msg.kind === 'done') {
            finish('done')
          }
        })
        .catch((err) => {
          console.error('bringing sessions over failed', err)
          finish('failed')
        })
    }
    // Closed before it finished: keep what arrived.
    const watch = setInterval(() => {
      if (popup.closed) void queue.then(() => finish(count > 0 ? 'done' : 'idle'))
    }, 1000)
    function stop() {
      window.removeEventListener('message', onMessage)
      clearInterval(watch)
      stopRef.current = null
    }
    window.addEventListener('message', onMessage)
    stopRef.current = stop
  }

  return (
    <p className="move-line" role="status">
      {state === 'moving' ? (
        <>Bringing them over{added > 0 ? `: ${added}` : ''}…</>
      ) : state === 'done' ? (
        added > 0 ? (
          <>Brought over {added} {added === 1 ? 'session' : 'sessions'}.</>
        ) : (
          <>Nothing new at {there}.</>
        )
      ) : (
        <>
          {state === 'blocked'
            ? 'Your browser blocked the window. Allow pop-ups here, then '
            : state === 'failed'
              ? "That didn't finish. "
              : `Sessions at ${there}? `}
          <button type="button" className="session-link" onClick={start}>
            {state === 'blocked' ? 'try again' : state === 'failed' ? 'Try again' : 'Bring them here'}
          </button>
        </>
      )}
    </p>
  )
}
