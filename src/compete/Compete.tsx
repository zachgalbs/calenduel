import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ensureProfile,
  fetchDailyTotals,
  fetchFriendSessions,
  isSignedIn,
  joinableRooms,
  listFriends,
  liveTimes,
  personLink,
  removeFriend,
  signIn,
  syncSessions,
  type Friend,
  type FriendSession,
  type Profile,
} from './api'
import {
  addDays,
  focusPercent,
  formatStudyTime,
  liveMs,
  localDay,
  weekSummary,
  withLive,
  type DailyTotal,
  type LiveSession,
  type WeekSummary,
} from './stats'
import CopyLink from '../room/CopyLink'
import { XIcon } from '../icons'
import { useUndoable } from '../useUndoable'
import './Compete.css'

const REFRESH_MS = 60_000
// Who's studying right now is re-read more often than the scores.
const LIVE_MS = 20_000
// Running sessions count up between those reads.
const TICK_MS = 1_000

function LiveDot({ on }: { on: boolean }) {
  return on ? <span className="live-dot" role="img" aria-label="studying now" title="Studying now" /> : null
}

interface Board {
  profile: Profile
  friends: Friend[]
  totals: DailyTotal[]
  failedUploads: number
  today: string // read at each refresh, so the board rolls over at midnight
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

function shortDay(day: string): string {
  // Noon, so the label can't slip onto the neighbouring date in any timezone.
  return new Date(`${day}T12:00:00`).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

// "77%", or a dash when nothing has been analyzed: 0% would claim no focus.
function percentText(focusMs: number, analyzedMs: number): string {
  const percent = focusPercent(focusMs, analyzedMs)
  return percent === null ? '–' : `${percent}%`
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`
}

// In the viewer's own timezone, so a friend abroad can fall on a different date
// than the day the session counted toward.
function sessionStart(startedAt: string): string {
  return new Date(startedAt).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// Mounted only while its section is open, so each opening fetches fresh sessions
// and closed cards cost nothing.
function FriendSessions({ friendId }: { friendId: string }) {
  const [sessions, setSessions] = useState<FriendSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let closed = false
    fetchFriendSessions(friendId)
      .then((rows) => {
        if (!closed) setSessions(rows)
      })
      .catch((err) => {
        if (!closed) setError(errorText(err))
      })
    return () => {
      closed = true
    }
  }, [friendId])

  if (error) return <p className="compete-error" role="alert">{error}</p>
  if (!sessions) return null
  if (sessions.length === 0) {
    return <p className="compete-note">No sessions yet.</p>
  }

  return (
    <table className="compete-table">
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <th scope="row">{sessionStart(s.startedAt)}</th>
              <td>{formatStudyTime(s.elapsedMs)}</td>
            </tr>
          ))}
        </tbody>
    </table>
  )
}

// "Studied yesterday", "Studied Tuesday", "Studied Nov 4": briefly, when.
function lastStudied(day: string | null, today: string): string {
  if (day === null) return 'Hasn’t studied yet'
  if (day === addDays(today, -1)) return 'Studied yesterday'
  const date = new Date(`${day}T12:00:00`)
  return day > addDays(today, -7)
    ? `Studied ${date.toLocaleDateString([], { weekday: 'long' })}`
    : `Studied ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
}

// How dark a day's square is: nothing, then under 45m, 1½h, 3h, and more.
function heatLevel(ms: number): number {
  const min = ms / 60_000
  return ms <= 0 ? 0 : min < 45 ? 1 : min < 90 ? 2 : min < 180 ? 3 : 4
}

// How far back the squares reach: a week by default, or four.
type Range = 7 | 28

const rangeText = (range: Range) => (range === 7 ? 'this week' : 'in 4 weeks')

// A column of seven squares per week, today last.
function Heatmap({ days, today, live }: { days: number[]; today: string; live: boolean }) {
  const total = days.reduce((a, b) => a + b, 0)
  const weeks: number[][] = []
  for (let from = 0; from < days.length; from += 7) weeks.push(days.slice(from, from + 7))
  return (
    <span
      className="heat"
      data-weeks={weeks.length}
      role="img"
      aria-label={`${formatStudyTime(total)} ${rangeText(days.length as Range)}`}
    >
      {weeks.map((week, w) => (
        <span key={w} className="heat-week">
          {week.map((ms, i) => {
            const index = w * 7 + i
            const isToday = index === days.length - 1
            const day = addDays(today, index - (days.length - 1))
            return (
              <span
                key={i}
                className="heat-day"
                data-level={heatLevel(ms)}
                data-today={isToday || undefined}
                data-live={(isToday && live) || undefined}
                title={`${shortDay(day)} · ${ms > 0 ? formatStudyTime(ms) : '–'}`}
              />
            )
          })}
        </span>
      ))}
    </span>
  )
}

// Above the squares: each day's initial for one week, each week's start for four.
function HeatHead({ today, range }: { today: string; range: Range }) {
  const label = (back: number, opts: Intl.DateTimeFormatOptions) =>
    new Date(`${addDays(today, -back)}T12:00:00`).toLocaleDateString([], opts)
  return (
    <div className="friend-head" aria-hidden="true">
      <span />
      {range === 7 ? (
        <span className="heat" data-weeks={1}>
          <span className="heat-week">
            {[6, 5, 4, 3, 2, 1, 0].map((back) => (
              <span key={back} className="heat-label">
                {label(back, { weekday: 'narrow' })}
              </span>
            ))}
          </span>
        </span>
      ) : (
        <span className="heat" data-weeks={4}>
          {[27, 20, 13, 6].map((back) => (
            <span key={back}>{label(back, { month: 'short', day: 'numeric' })}</span>
          ))}
        </span>
      )}
      <span>{range === 7 ? 'Week' : '4 wks'}</span>
      <span>Streak</span>
      <span />
    </div>
  )
}

type Status = { kind: 'studying' | 'break'; ms: number } | null

// One friend, one line: who, their squares, the totals, and a way in.
// Opening it shows the rest.
function FriendRow({
  friend,
  summary,
  status,
  range,
  today,
  joinCode,
  onJoin,
  onRemoved,
}: {
  friend: Friend
  summary: WeekSummary
  status: Status
  range: Range
  today: string
  joinCode: string | null
  onJoin: (code: string) => void
  onRemoved: () => void
}) {
  const [open, setOpen] = useState(false)
  // Removing takes a few seconds to happen, so it can be undone.
  const removal = useUndoable(async () => {
    await removeFriend(friend.id)
    onRemoved()
  })

  const totalMs = range === 7 ? summary.weekMs : summary.daysMs
  // Only what's happening now; the squares say the rest.
  const line =
    status?.kind === 'studying' ? formatStudyTime(status.ms) : status?.kind === 'break' ? 'Break' : null

  if (removal.pending) {
    return (
      <li className="friend-row">
        <p className="undo-line" role="status">
          Removed {friend.name}
          <button type="button" onClick={removal.undo}>Undo</button>
        </p>
      </li>
    )
  }

  return (
    <li className="friend-row" data-live={status !== null}>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="friend-line reveal">
          <span className="friend-who">
            <span className="friend-name">
              {friend.name}
              <LiveDot on={status?.kind === 'studying'} />
            </span>
            {line && <span className="friend-status">{line}</span>}
          </span>
          <Heatmap
            days={range === 7 ? summary.week : summary.days}
            today={today}
            live={status?.kind === 'studying'}
          />
          <span className="friend-num">{totalMs > 0 ? formatStudyTime(totalMs) : '–'}</span>
          <span className="friend-num">{summary.streak > 0 ? `${summary.streak}d` : '–'}</span>
          {/* Join, or else Remove on hover: the slot is always there, so columns line up. */}
          <span className="friend-join">
            {joinCode ? (
              <button
                type="button"
                className="compete-btn primary"
                onClick={(e) => {
                  e.preventDefault() // a click on Join shouldn't also open the row
                  onJoin(joinCode)
                }}
              >
                Join
              </button>
            ) : (
              <button
                type="button"
                className="icon-btn reveal-item"
                aria-label={`Remove ${friend.name}`}
                title="Remove friend"
                onClick={(e) => {
                  e.preventDefault() // not also open the row
                  removal.start()
                }}
              >
                <XIcon size={12} />
              </button>
            )}
          </span>
        </summary>

        {open && (
          <div className="friend-more">
            <dl className="friend-facts">
              <div>
                <dt>This week</dt>
                <dd>{formatStudyTime(summary.weekMs)}</dd>
              </div>
              <div>
                <dt>Last studied</dt>
                <dd>{lastStudied(summary.lastDay, today)}</dd>
              </div>
              <div>
                <dt>Focus</dt>
                <dd>{percentText(summary.focusMs, summary.analyzedMs)}</dd>
              </div>
              <div>
                <dt>Friends since</dt>
                <dd>{shortDay(friend.since)}</dd>
              </div>
            </dl>

            <FriendSessions friendId={friend.id} />
          </div>
        )}
      </details>
    </li>
  )
}

export default function Compete({
  room = null,
  onJoin = () => {},
}: {
  // This tab's study room, so there's no Join button for a room you're in.
  room?: string | null
  // Join a friend's room and start studying in it, on this click.
  onJoin?: (code: string) => void
}) {
  // null = still finding out.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Sessions running right now, and the clock their time is counted to.
  const [live, setLive] = useState<LiveSession[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [range, setRange] = useState<Range>(7)
  const liveIdsRef = useRef<Set<string>>(new Set())

  // A failed read keeps the last answer: live time is a nicety, and the
  // session counts for real once it's uploaded.
  const fetchLive = useCallback(async (): Promise<LiveSession[] | null> => {
    try {
      return await liveTimes()
    } catch (err) {
      console.error('live status failed', err)
      return null
    }
  }, [])

  // Someone dropping out of the live list means their session stopped and
  // uploaded (or was dropped), so the totals need reading again to take it in.
  const showLive = useCallback((rows: LiveSession[]): boolean => {
    const ids = new Set(rows.map((r) => r.userId))
    const ended = [...liveIdsRef.current].some((id) => !ids.has(id))
    liveIdsRef.current = ids
    setLive(rows)
    setNow(Date.now())
    return ended
  }, [])
  // Friends in a session, and the room to join each one in.
  const [rooms, setRooms] = useState<Map<string, string>>(() => new Map())

  const refresh = useCallback(async () => {
    try {
      const active = await isSignedIn()
      setSignedIn(active)
      if (!active) return
      // Upload first, so your own numbers on this page are never behind.
      const failedUploads = await syncSessions()
      // Live, totals, live again. An upload that lands in between takes its
      // session out of the second live read, so if anyone left, the totals
      // are read once more. That way the two always agree: a session is in
      // the totals or in the live list, never both and never neither.
      const before = await fetchLive()
      const [profile, friends, firstTotals] = await Promise.all([
        ensureProfile(),
        listFriends(),
        fetchDailyTotals(),
      ])
      let totals = firstTotals
      const after = await fetchLive()
      const ids = new Set(after?.map((r) => r.userId))
      if (before && after && before.some((r) => !ids.has(r.userId))) {
        totals = await fetchDailyTotals()
      }
      setBoard({ profile, friends, totals, failedUploads, today: localDay(Date.now()) })
      if (after) showLive(after)
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [fetchLive, showLive])

  // Keeps the scoreboard current without a realtime connection: refresh on open,
  // on returning to the tab, and once a minute while it's actually being viewed.
  useEffect(() => {
    // refresh() only setStates after its first await, so this is an async data
    // fetch rather than a synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // Between full refreshes, who's in a session is re-read on its own.
  const signedInNow = signedIn === true
  useEffect(() => {
    if (!signedInNow) return
    const read = () => {
      if (document.visibilityState !== 'visible') return
      void fetchLive().then((rows) => {
        if (rows && showLive(rows)) void refresh()
      })
    }
    const timer = setInterval(read, LIVE_MS)
    document.addEventListener('visibilitychange', read)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', read)
    }
  }, [signedInNow, fetchLive, showLive, refresh])

  // The Join buttons, on the same rhythm. A failed read keeps the last answer.
  useEffect(() => {
    if (!signedInNow) return
    let closed = false
    const read = () => {
      if (document.visibilityState !== 'visible') return
      joinableRooms()
        .then((r) => {
          if (!closed) setRooms(r)
        })
        .catch((err) => console.error('study rooms failed', err))
    }
    read()
    const timer = setInterval(read, LIVE_MS)
    document.addEventListener('visibilitychange', read)
    return () => {
      closed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', read)
    }
  }, [signedInNow])

  const ticking = live.some((s) => s.frozenAt === null)
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [ticking])

  async function handleSignIn() {
    setError(null)
    try {
      await signIn()
    } catch (err) {
      setError(errorText(err))
    }
  }

  const totals = board ? withLive(board.totals, live, now) : []
  // What each friend is doing now. A break keeps its room open, so it counts;
  // a stopped session waiting on its upload doesn't.
  const statusOf = (id: string): Status => {
    const s = live.find((l) => l.userId === id)
    if (!s) return null
    if (s.frozenAt === null) return { kind: 'studying', ms: liveMs(s, now) }
    return rooms.has(id) ? { kind: 'break', ms: liveMs(s, now) } : null
  }
  const rows = board
    ? board.friends.map((f) => ({
        friend: f,
        summary: weekSummary(totals, f.id, board.today),
        status: statusOf(f.id),
      }))
    : []
  // Who you can join first, then whoever has studied most in the range.
  // Anyone with nothing in it folds away into one line.
  const rangeMs = (r: (typeof rows)[number]) => (range === 7 ? r.summary.weekMs : r.summary.daysMs)
  const rank = (r: (typeof rows)[number]) =>
    r.status?.kind === 'studying' ? 2 : r.status?.kind === 'break' ? 1 : 0
  const active = rows
    .filter((r) => r.status !== null || rangeMs(r) > 0)
    .sort((a, b) => rank(b) - rank(a) || rangeMs(b) - rangeMs(a))
  const quiet = rows.filter((r) => r.status === null && rangeMs(r) === 0)
  const studyingNow = rows.filter((r) => r.status?.kind === 'studying').length
  const studiedToday = rows.filter((r) => r.status?.kind === 'studying' || r.summary.todayMs > 0).length

  return (
    <main className="compete">
      <header className="compete-head">
        <h1>Friends</h1>
        {board && <CopyLink link={personLink(board.profile.name)} />}
      </header>

      {error && <p className="compete-error" role="alert">{error}</p>}

      {signedIn === false && (
        <section className="compete-section">
          <p className="compete-lead">Study with your friends.</p>
          <button type="button" className="compete-btn primary" onClick={handleSignIn}>
            Sign in with Google
          </button>
        </section>
      )}

      {board && (
        <>
          {board.failedUploads > 0 && (
            <p className="compete-error" role="alert">
              {plural(board.failedUploads, 'session')} couldn't upload. Check your
              clock.
            </p>
          )}

          {/* Friends are people you've studied with: joining someone's
              table, or them joining yours, is what connects you. */}
          {board.friends.length === 0 && (
            <p className="compete-lead">Send someone your link.</p>
          )}

          {board.friends.length > 0 && (
            <section className="compete-section">
              <div className="friend-pulse">
                <p>
                  {studyingNow > 0 && (
                    <span className="friend-pulse-live">
                      <LiveDot on /> {studyingNow} studying ·{' '}
                    </span>
                  )}
                  {studiedToday} of {board.friends.length} today
                </p>
                <span className="heat-range" role="group" aria-label="Range">
                  {([7, 28] as const).map((r) => (
                    <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
                      {r === 7 ? '1 wk' : '4 wks'}
                    </button>
                  ))}
                </span>
              </div>
              {active.length > 0 && <HeatHead today={board.today} range={range} />}
              {active.length > 0 ? (
                <ul className="friend-rows">
                  {active.map((r) => (
                    <FriendRow
                      key={r.friend.id}
                      friend={r.friend}
                      summary={r.summary}
                      status={r.status}
                      range={range}
                      today={board.today}
                      joinCode={
                        rooms.has(r.friend.id) && rooms.get(r.friend.id) !== room
                          ? rooms.get(r.friend.id)!
                          : null
                      }
                      onJoin={onJoin}
                      onRemoved={refresh}
                    />
                  ))}
                </ul>
              ) : (
                <p className="compete-note">Nobody's studied {rangeText(range)}.</p>
              )}

              {quiet.length > 0 && (
                <details className="friend-quiet">
                  <summary>
                    {plural(quiet.length, 'friend')} quiet {rangeText(range).replace('in ', 'for ')}
                  </summary>
                  <ul className="friend-rows">
                    {quiet.map((r) => (
                      <FriendRow
                        key={r.friend.id}
                        friend={r.friend}
                        summary={r.summary}
                        status={null}
                          range={range}
                      today={board.today}
                        joinCode={null}
                        onJoin={onJoin}
                        onRemoved={refresh}
                      />
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
        </>
      )}
    </main>
  )
}
