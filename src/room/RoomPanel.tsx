import { useEffect, useState } from 'react'
import Members from './Members'
import { useNow, useRoom } from './useRoom'
import './Room.css'

// The study room, beside the timer: who's studying and for how long. Also what
// keeps you present in it, with your current stretch of studying. Every
// session has a room, so it only shows once someone else is in yours.
export default function RoomPanel({
  code,
  studyingSince,
  onLeave,
}: {
  code: string
  studyingSince: number | null
  onLeave: () => void
}) {
  const { state, beatFailing } = useRoom(code, studyingSince)
  const [myId, setMyId] = useState<string | null>(null)
  const live = state?.members.some((m) => m.liveSince !== null) ?? false
  const now = useNow(live)

  useEffect(() => {
    let closed = false
    import('../compete/api')
      .then(({ ensureProfile }) => ensureProfile())
      .then((p) => {
        if (!closed) setMyId(p.id)
      })
      .catch(() => {})
    return () => {
      closed = true
    }
  }, [])

  if (!state || !myId || !state.members.some((m) => m.id !== myId)) return null
  const studying = state.members.filter((m) => m.liveSince !== null).length

  return (
    <aside className="room-panel" aria-label="Studying together">
      <header className="room-panel-head">
        <span className="room-panel-title">Studying together</span>
        <span className={studying > 0 ? 'room-live on' : 'room-live'}>
          <span className="room-live-dot" aria-hidden="true" />
          {studying > 0 ? `${studying} studying` : 'Nobody studying yet'}
        </span>
      </header>
      <Members members={state.members} myId={myId} now={now} compact />
      {beatFailing && (
        <p className="room-error" role="alert">
          Can't reach the study room, so the others may not see you studying.
        </p>
      )}
      {studyingSince === null && (
        <footer className="room-panel-foot">
          <button type="button" className="room-link" onClick={onLeave}>
            Study alone next time
          </button>
        </footer>
      )}
    </aside>
  )
}
