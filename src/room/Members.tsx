import type { RoomMember } from '../compete/api'
import { formatStudyTime } from '../compete/stats'
import Avatar from '../Avatar'
import { clock, memberMs } from './useRoom'

// The people in a group study. "Most so far" marks whoever has put in the most
// time: it's a shared session, but you can still see who's carrying it.
export default function Members({
  members,
  myId,
  now,
  compact = false,
}: {
  members: RoomMember[]
  myId: string | null
  now: number
  compact?: boolean
}) {
  const sorted = [...members].sort((a, b) => memberMs(b, now) - memberMs(a, now))
  const top = sorted.length > 1 && memberMs(sorted[0], now) > 0 ? sorted[0].id : null

  return (
    <ul className={compact ? 'members compact' : 'members'}>
      {sorted.map((m) => {
        const live = m.liveSince !== null
        const total = memberMs(m, now)
        return (
          <li key={m.id} className={live ? 'member live' : m.here ? 'member' : 'member away'}>
            <div className="member-face">
              <Avatar name={m.name} src={m.avatar} size={compact ? 32 : 44} />
              {live && <span className="member-dot" aria-hidden="true" />}
            </div>
            <div className="member-body">
              <div className="member-name">
                {m.name}
                {m.id === myId && <span className="member-you"> (you)</span>}
                {m.isHost && !compact && <span className="member-host">host</span>}
              </div>
              <div className="member-status">
                {live ? (
                  <span className="member-live">
                    Studying <span className="member-clock">{clock(now - m.liveSince!)}</span>
                  </span>
                ) : !m.here ? (
                  'Away'
                ) : total > 0 ? (
                  'On a break'
                ) : (
                  'Here'
                )}
              </div>
            </div>
            {(total > 0 || top === m.id) && (
              <div className="member-total">
                {total > 0 && formatStudyTime(total)}
                {top === m.id && <span className="member-top">Most so far</span>}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
