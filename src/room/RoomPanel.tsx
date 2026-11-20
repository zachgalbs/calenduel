import StudyTable, { type TablePerson } from './StudyTable'
import { useRoom } from './useRoom'
import { useMe } from './useMe'

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

// The study room, as a table: everyone here has a seat, lit while they study
// and dark on a break; someone who stops leaves the table. Also what keeps you
// present in it, with your current stretch of studying.
export default function RoomPanel({
  code,
  selfId,
  guest,
  studyingSince,
  onLamp,
  lampLabel,
}: {
  code: string
  selfId: string // how the room knows you, so you don't sit twice
  guest: boolean
  studyingSince: number | null
  onLamp?: () => void
  lampLabel?: string
}) {
  const { people: others, beatFailing } = useRoom(code, studyingSince, guest)
  const me = useMe()

  // The room lists you too, as everyone else sees you: a guest's number, or
  // your own name and picture. Used first, so the table never shows a
  // placeholder you while it's right there.
  const seen = others.find((p) => p.id === selfId)
  const name = seen?.name ?? me.name
  const avatar = guest ? null : (seen?.avatar ?? me.avatar)
  const people: TablePerson[] = [
    { id: 'me', name, avatar, lit: studyingSince !== null },
    ...others
      .filter((p) => p.id !== selfId)
      .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, lit: p.live })),
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
