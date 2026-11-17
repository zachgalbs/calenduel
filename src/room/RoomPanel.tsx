import { useEffect, useState } from 'react'
import Members from './Members'
import { memberMs, useNow, useRoom } from './useRoom'
import { formatStudyTime } from '../compete/stats'
import './Room.css'

// The group study, beside the timer: who's studying and for how long. Also what
// keeps you present in it, with your running session's start time.
export default function RoomPanel({
  code,
  studyingSince,
  onLeave,
}: {
  code: string
  studyingSince: number | null
  onLeave: () => void
}) {
  const { state } = useRoom(code, studyingSince)
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

  if (!state) return null
  const studying = state.members.filter((m) => m.liveSince !== null).length
  const together = state.members.reduce((sum, m) => sum + memberMs(m, now), 0)

  async function handleLeave() {
    try {
      const { leaveRoom } = await import('../compete/api')
      await leaveRoom(code)
    } catch {
      // Still leave here; the room shows you as away soon after.
    }
    onLeave()
  }

  return (
    <aside className="room-panel" aria-label="Group study">
      <header className="room-panel-head">
        <span className="room-panel-title">Group study</span>
        <span className={studying > 0 ? 'room-live on' : 'room-live'}>
          <span className="room-live-dot" aria-hidden="true" />
          {studying > 0 ? `${studying} studying` : 'Nobody studying yet'}
        </span>
      </header>
      <Members members={state.members} myId={myId} now={now} compact />
      <footer className="room-panel-foot">
        <span>
          Together <strong>{together > 0 ? formatStudyTime(together) : '—'}</strong>
        </span>
        {studyingSince === null && (
          <button type="button" className="room-link" onClick={handleLeave}>
            Leave group study
          </button>
        )}
      </footer>
    </aside>
  )
}
