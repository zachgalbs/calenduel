import { useEffect, useState } from 'react'
import Avatar from '../Avatar'
import './Room.css'

// Your session's table, beside the timer. Alone it's a one-person desk; each
// person who joins walks in and takes a seat, the table stretches to fit, and
// the view pulls back. A lamp in front of each seat is lit while that person
// studies and dims on a break. Your own lamp is the pause switch: click it to
// take a break, click again to carry on. No words: the room explains itself.

export interface TablePerson {
  id: string
  name: string
  avatar: string | null
  lit: boolean
}

type Phase = 'enter' | 'in' | 'leave'
type Seated = TablePerson & { phase: Phase }

// The world is drawn at this size and the camera scales it; CSS keeps the
// stage the same size, so the numbers here are the layout.
const W = 384
const H = 208
const GAP = 84 // between seats along the table
const AVATAR = 40
const LEAVE_MS = 1100

// Keeps people who just left on screen long enough to walk out, and brings
// new arrivals in from off stage.
function seat(prev: Seated[], people: TablePerson[]): Seated[] {
  const now = new Map(people.map((p) => [p.id, p]))
  const kept: Seated[] = prev.map((s) => {
    const p = now.get(s.id)
    return p ? { ...p, phase: s.phase === 'leave' ? 'enter' : s.phase } : { ...s, phase: 'leave' }
  })
  const known = new Set(prev.map((s) => s.id))
  const arrivals: Seated[] = people
    .filter((p) => !known.has(p.id))
    .map((p) => ({ ...p, phase: 'enter' }))
  return [...kept, ...arrivals]
}

// Seat i: you at the front, the first friend across from you, then the table
// grows a column at a time, top first.
function place(i: number): { col: number; top: boolean } {
  if (i === 0) return { col: 0, top: false }
  if (i === 1) return { col: 0, top: true }
  return { col: Math.floor(i / 2), top: i % 2 === 0 }
}

export default function StudyTable({
  people,
  onLamp,
  lampLabel,
}: {
  people: TablePerson[]
  // Your lamp's click (id 'me'), while a session runs: pause or resume.
  onLamp?: () => void
  lampLabel?: string
}) {
  const key = people.map((p) => `${p.id}:${p.lit ? 1 : 0}:${p.avatar ?? ''}`).join('|')
  const [seen, setSeen] = useState(key)
  // Whoever is already here on first render is simply seated, no entrance.
  const [seated, setSeated] = useState<Seated[]>(() => people.map((p) => ({ ...p, phase: 'in' })))
  if (key !== seen) {
    setSeen(key)
    setSeated(seat(seated, people))
  }

  // An arrival is drawn off stage first, then moved to its seat on the next
  // frame, so the move animates. Leavers are dropped once they've walked out.
  useEffect(() => {
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    if (seated.some((s) => s.phase === 'enter')) {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() =>
          setSeated((all) => all.map((s) => (s.phase === 'enter' ? { ...s, phase: 'in' } : s))),
        )
      })
    }
    if (seated.some((s) => s.phase === 'leave')) {
      timer = setTimeout(() => setSeated((all) => all.filter((s) => s.phase !== 'leave')), LEAVE_MS)
    }
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [seated])

  const n = seated.length
  const cols = Math.max(1, Math.ceil(n / 2))
  const solo = n <= 1
  const tw = solo ? 64 : cols * GAP + 16
  const th = solo ? 52 : 76
  const cx = W / 2
  const cy = H / 2
  const tTop = cy - th / 2
  const colX = (c: number) => cx + (c - (cols - 1) / 2) * GAP
  // The camera frames the table and every seat: close on a lone desk, pulling
  // back as the table fills, never cropping anyone.
  const hasTop = n >= 2
  const boxTop = hasTop ? tTop - AVATAR - 10 : tTop
  const boxBottom = tTop + th + 10 + AVATAR
  const boxW = Math.max(tw, cols * GAP)
  const zoom = solo ? 1.6 : n === 2 ? 1.35 : 1.15
  const scale = Math.min(zoom, (W - 24) / boxW, (H - 16) / (boxBottom - boxTop))
  const shiftY = cy - (boxTop + boxBottom) / 2

  const label = seated
    .filter((s) => s.phase !== 'leave')
    .map((s) => `${s.name}${s.lit ? '' : ' (on a break)'}`)
    .join(', ')

  return (
    <div className="study-table" role="group" aria-label={`At your table: ${label}`}>
      <div className="study-world" style={{ transform: `scale(${scale}) translateY(${shiftY}px)` }}>
        <div
          className="study-surface"
          style={{ left: cx - tw / 2, top: tTop, width: tw, height: th }}
        />
        {seated.map((s, i) => {
          const { col, top } = place(i)
          const away = s.phase !== 'in'
          // Off stage to whichever side is nearer that seat's end of the table.
          const offX = col < (cols - 1) / 2 || (cols === 1 && i % 2 === 1) ? -W * 0.7 : W * 1.7
          const x = away ? offX : colX(col)
          const y = top ? tTop - AVATAR - 10 : tTop + th + 10
          const lampY = top ? tTop + 12 : tTop + th - 24
          return (
            <div key={s.id}>
              {s.id === 'me' && onLamp ? (
                <button
                  type="button"
                  className="study-lamp-switch"
                  aria-label={lampLabel}
                  title={lampLabel}
                  onClick={onLamp}
                  style={{ transform: `translate(${x - 16}px, ${lampY - 10}px)` }}
                >
                  <span className="study-lamp" data-lit={s.lit} />
                </button>
              ) : (
                <span
                  className="study-lamp"
                  data-lit={s.lit && !away}
                  style={{ transform: `translate(${x - 6}px, ${lampY}px)`, opacity: away ? 0 : 1 }}
                />
              )}
              <span
                className="study-seat"
                title={s.name}
                style={{ transform: `translate(${x - AVATAR / 2}px, ${y}px)`, opacity: away ? 0 : 1 }}
              >
                <Avatar name={s.name} src={s.avatar} size={AVATAR} />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
