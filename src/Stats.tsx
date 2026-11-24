import { lazy, Suspense, useCallback, useState } from 'react'
import History from './History'
import PageBoundary from './PageBoundary'
import type { SessionMeta } from './db'
import { addDays, focusPercent, formatStudyTime, localDay, weekSummary, type DailyTotal } from './compete/stats'
import { summarizeFocus } from './focus/types'
import './Stats.css'

// The auth and database SDK is big and only the friends part uses it, so it
// loads on demand: your own numbers and sessions don't wait on it.
const Compete = lazy(() => import('./compete/Compete'))

// Your sessions on this device as daily totals, the shape the friends board
// uses, so the same rules (streak, week, focus) apply. Works signed out.
function localTotals(sessions: SessionMeta[]): DailyTotal[] {
  const byDay = new Map<string, DailyTotal>()
  for (const s of sessions) {
    const day = localDay(s.startedAt)
    const t = byDay.get(day) ?? { userId: 'me', day, totalMs: 0, focusMs: 0, analyzedMs: 0 }
    t.totalMs += s.elapsedMs
    // Focus counts only where it was measured under the session's current name.
    if (s.focus && s.focus.task === s.task) {
      t.focusMs += Math.min(summarizeFocus(s.focus.samples).onMs, s.elapsedMs)
      t.analyzedMs += s.elapsedMs
    }
    byDay.set(day, t)
  }
  return [...byDay.values()]
}

function You({ sessions, today }: { sessions: SessionMeta[]; today: string }) {
  const sum = weekSummary(localTotals(sessions), 'me', today)
  const focus = focusPercent(sum.focusMs, sum.analyzedMs)
  const top = Math.max(1, ...sum.week)
  return (
    <section className="you" aria-label="You">
      <div className="you-today">
        <span className="you-big">{formatStudyTime(sum.todayMs)}</span>
        <span className="you-label">today</span>
      </div>
      <dl className="you-figures">
        <div>
          <dt>This week</dt>
          <dd>{formatStudyTime(sum.weekMs)}</dd>
        </div>
        <div>
          <dt>Streak</dt>
          <dd>{sum.streak > 0 ? `${sum.streak}d` : '–'}</dd>
        </div>
        <div>
          <dt>Focus</dt>
          <dd>{focus === null ? '–' : `${focus}%`}</dd>
        </div>
      </dl>
      <div className="you-bars" role="img" aria-label="The last 7 days">
        {sum.week.map((ms, i) => {
          const day = addDays(today, i - 6)
          const date = new Date(`${day}T12:00:00`)
          return (
            <div
              key={day}
              className="you-bar"
              data-today={i === 6 || undefined}
              title={`${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${ms > 0 ? formatStudyTime(ms) : '–'}`}
            >
              <span className="you-bar-track">
                <span className="you-bar-fill" style={{ height: `${(ms / top) * 100}%` }} />
              </span>
              <span className="you-bar-day">{date.toLocaleDateString([], { weekday: 'narrow' })}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// One page for how you're doing: your numbers, your friends, your sessions.
export default function Stats({
  room,
  onJoin,
}: {
  room: string | null
  onJoin: (code: string) => void
}) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  // Read once: the page is remounted after every session anyway.
  const [today] = useState(() => localDay(Date.now()))
  const onSessions = useCallback((s: SessionMeta[]) => setSessions(s), [])
  return (
    <main className="stats">
      <h1>Stats</h1>
      {sessions && <You sessions={sessions} today={today} />}
      <PageBoundary>
        <Suspense fallback={null}>
          <Compete room={room} onJoin={onJoin} />
        </Suspense>
      </PageBoundary>
      <History onSessions={onSessions} />
    </main>
  )
}
