import { useEffect, useState } from 'react'
import StudyTable, { type TablePerson } from './StudyTable'
import { useRoom } from './useRoom'

// You, as the table shows you: your picture once signed in. Your seat is
// keyed 'me' throughout, so the room loading in doesn't walk you out and back.
function useMe(): { id: string | null; name: string; avatar: string | null } {
  const [me, setMe] = useState<{ id: string | null; name: string; avatar: string | null }>({
    id: null,
    name: 'You',
    avatar: null,
  })
  useEffect(() => {
    let closed = false
    import('../compete/api')
      .then(async ({ isSignedIn, ensureProfile }) => {
        if (!(await isSignedIn())) return
        const p = await ensureProfile()
        if (!closed) setMe({ id: p.id, name: p.name, avatar: p.avatar })
      })
      .catch(() => {})
    return () => {
      closed = true
    }
  }, [])
  return me
}

// Studying with nobody's room to sit in: a one-person desk.
export function SoloTable({
  studying,
  onLamp,
  lampLabel,
}: {
  studying: boolean
  onLamp?: () => void
  lampLabel?: string
}) {
  const me = useMe()
  return (
    <StudyTable
      people={[{ id: 'me', name: me.name, avatar: me.avatar, lit: studying }]}
      onLamp={onLamp}
      lampLabel={lampLabel}
    />
  )
}

// The study room, as a table: everyone here has a seat, lit while they study.
// Also what keeps you present in it, with your current stretch of studying.
export default function RoomPanel({
  code,
  studyingSince,
  onLamp,
  lampLabel,
}: {
  code: string
  studyingSince: number | null
  onLamp?: () => void
  lampLabel?: string
}) {
  const { state, beatFailing } = useRoom(code, studyingSince)
  const me = useMe()

  const people: TablePerson[] = [
    { id: 'me', name: me.name, avatar: me.avatar, lit: studyingSince !== null },
    // Others only once we know which member is you, or you'd sit twice.
    ...(me.id ? (state?.members ?? []) : [])
      .filter((m) => m.id !== me.id && m.here)
      .map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, lit: m.liveSince !== null })),
  ]

  return (
    <>
      <StudyTable people={people} onLamp={onLamp} lampLabel={lampLabel} />
      {beatFailing && (
        <p className="room-error" role="alert">
          Can't reach the room, so the others may not see you.
        </p>
      )}
    </>
  )
}
