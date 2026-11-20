import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ensureProfile,
  fetchDailyTotals,
  fetchFriendSessions,
  FRIEND_SESSION_LIMIT,
  isSignedIn,
  joinableRooms,
  listFriends,
  liveTimes,
  personLink,
  removeFriend,
  signIn,
  signOut,
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
import Avatar from '../Avatar'
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
  if (!sessions) return <p className="compete-note">Loading...</p>
  if (sessions.length === 0) {
    return <p className="compete-note">No sessions since you connected.</p>
  }

  return (
    <>
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
      {sessions.length === FRIEND_SESSION_LIMIT && (
        <p className="compete-note">Showing the latest {FRIEND_SESSION_LIMIT}.</p>
      )}
    </>
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

// Seven small bars, oldest to today, on one scale for everyone on the page.
function WeekBars({ week, scaleMs }: { week: number[]; scaleMs: number }) {
  const total = week.reduce((a, b) => a + b, 0)
  return (
    <span className="week-bars" role="img" aria-label={`${formatStudyTime(total)} this week`}>
      {week.map((ms, i) => (
        <span
          key={i}
          className="week-bar"
          data-today={i === week.length - 1}
          style={{ height: ms > 0 ? `${Math.max(12, Math.round((100 * ms) / scaleMs))}%` : undefined }}
        />
      ))}
    </span>
  )
}

type Status = { kind: 'studying' | 'break'; ms: number } | null

// One friend, one line: who, what they're doing or when they last studied,
// their week, and a way in. Opening it shows the rest.
function FriendRow({
  friend,
  summary,
  status,
  scaleMs,
  today,
  joinCode,
  onJoin,
  onRemoved,
}: {
  friend: Friend
  summary: WeekSummary
  status: Status
  scaleMs: number
  today: string
  joinCode: string | null
  onJoin: (code: string) => void
  onRemoved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const line =
    status?.kind === 'studying'
      ? `Studying · ${formatStudyTime(status.ms)}`
      : status?.kind === 'break'
        ? 'On a break'
        : summary.todayMs > 0
          ? `${formatStudyTime(summary.todayMs)} today`
          : lastStudied(summary.lastDay, today)

  async function handleRemove() {
    setError(null)
    try {
      await removeFriend(friend.id)
      onRemoved()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <li className="friend-row" data-live={status !== null}>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="friend-line">
          <Avatar name={friend.name} src={friend.avatar} size={36} />
          <span className="friend-who">
            <span className="friend-name">
              {friend.name}
              <LiveDot on={status?.kind === 'studying'} />
            </span>
            <span className="friend-status">{line}</span>
          </span>
          <WeekBars week={summary.week} scaleMs={scaleMs} />
          {/* The slot is always there, so the week bars line up row to row. */}
          <span className="friend-join">
            {joinCode && (
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
                <dt>Streak</dt>
                <dd>{plural(summary.streak, 'day')}</dd>
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

            <details
              className="friend-sessions"
              onToggle={(e) => setSessionsOpen(e.currentTarget.open)}
            >
              <summary>Sessions</summary>
              {sessionsOpen && <FriendSessions friendId={friend.id} />}
            </details>

            <div className="friend-actions">
              {confirming ? (
                <>
                  <button type="button" className="compete-btn danger" onClick={handleRemove}>
                    Remove {friend.name}
                  </button>
                  <button type="button" className="compete-btn" onClick={() => setConfirming(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" className="compete-link" onClick={() => setConfirming(true)}>
                  Remove friend
                </button>
              )}
            </div>
            {error && <p className="compete-error" role="alert">{error}</p>}
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

  async function handleSignOut() {
    setError(null)
    try {
      await signOut()
      setBoard(null)
      setSignedIn(false)
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
  // Who's here first, then who studied today, then the rest of the week.
  // Anyone with nothing all week folds away into one line.
  const rank = (r: (typeof rows)[number]) =>
    r.status?.kind === 'studying' ? 2 : r.status?.kind === 'break' ? 1 : 0
  const active = rows
    .filter((r) => r.status !== null || r.summary.weekMs > 0)
    .sort(
      (a, b) =>
        rank(b) - rank(a) ||
        b.summary.todayMs - a.summary.todayMs ||
        b.summary.weekMs - a.summary.weekMs,
    )
  const quiet = rows.filter((r) => r.status === null && r.summary.weekMs === 0)
  const scaleMs = Math.max(1, ...active.flatMap((r) => r.summary.week))

  return (
    <main className="compete">
      <header className="compete-head">
        <h1>Friends</h1>
      </header>

      {error && <p className="compete-error" role="alert">{error}</p>}

      {signedIn === null && !error && <p className="compete-note">Loading...</p>}

      {signedIn === false && (
        <section className="compete-section">
          <p className="compete-lead">
            Study alongside your friends. See when they're studying, join them in
            a click, and keep each other going day by day.
          </p>
          <button type="button" className="compete-btn primary" onClick={handleSignIn}>
            Sign in with Google
          </button>
          <p className="compete-note">
            Signing in uploads the start time and length of your sessions so they
            can count and friends you add can see them. Your clips stay on this
            device.
          </p>
        </section>
      )}

      {signedIn && !board && !error && <p className="compete-note">Loading...</p>}

      {board && (
        <>
          {board.failedUploads > 0 && (
            <p className="compete-error" role="alert">
              {plural(board.failedUploads, 'session')} couldn't be uploaded and
              {board.failedUploads === 1 ? " isn't" : " aren't"} counted yet. Check
              that your computer's clock is right.
            </p>
          )}

          {/* Friends are people you've studied with: joining someone's
              table, or them joining yours, is what connects you. */}
          {board.friends.length === 0 && (
            <p className="compete-lead">
              Send someone your link. When they join you while you're studying,
              you're friends.
            </p>
          )}

          {board.friends.length > 0 && (
            <section className="compete-section">
              {active.length > 0 ? (
                <ul className="friend-rows">
                  {active.map((r) => (
                    <FriendRow
                      key={r.friend.id}
                      friend={r.friend}
                      summary={r.summary}
                      status={r.status}
                      scaleMs={scaleMs}
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
                <p className="compete-note">Nobody's studied this week yet.</p>
              )}

              {quiet.length > 0 && (
                <details className="friend-quiet">
                  <summary>{plural(quiet.length, 'friend')} quiet this week</summary>
                  <ul className="friend-rows">
                    {quiet.map((r) => (
                      <FriendRow
                        key={r.friend.id}
                        friend={r.friend}
                        summary={r.summary}
                        status={null}
                        scaleMs={scaleMs}
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

          <div className="compete-foot">
            <CopyLink
              link={personLink(board.profile.name)}
              className="compete-link"
              label="Copy your link"
            />
            <button type="button" className="compete-link" onClick={handleSignOut}>
              Sign out {board.profile.name}
            </button>
          </div>
        </>
      )}
    </main>
  )
}
