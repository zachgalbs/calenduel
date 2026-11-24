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

function dayLabel(day: string, opts: Intl.DateTimeFormatOptions): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString([], opts)
}

function You({ sessions, today }: { sessions: SessionMeta[]; today: string }) {
  const totals = localTotals(sessions)
  const sum = weekSummary(totals, 'me', today)
  const focus = focusPercent(sum.focusMs, sum.analyzedMs)
  // How many weeks back the bars are, and the day pointed at (hover, focus or
  // a tap), whose time takes the big number's place.
  const [weeksBack, setWeeksBack] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)
  const end = addDays(today, -7 * weeksBack)
  const week = weekSummary(totals, 'me', end).week
  const top = Math.max(1, ...week)
  const byDay = new Map(totals.map((t) => [t.day, t.totalMs]))
  // Back as far as your first session, never past today.
  const first = totals.reduce<string | null>((min, t) => (min === null || t.day < min ? t.day : min), null)
  const canGoBack = first !== null && addDays(end, -7) >= first
  const shown = picked ?? today
  return (
    <section className="you" aria-label="You">
      <div className="you-today" aria-live="polite">
        <span className="you-big">{formatStudyTime(byDay.get(shown) ?? 0)}</span>
        <span className="you-label">
          {shown === today ? 'today' : dayLabel(shown, { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
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
      <div className="you-week">
        <button
          type="button"
          className="you-step"
          aria-label="Week before"
          title="Week before"
          disabled={!canGoBack}
          onClick={() => setWeeksBack((w) => w + 1)}
        >
          ‹
        </button>
        <div className="you-bars" onMouseLeave={() => setPicked(null)}>
          {week.map((ms, i) => {
            const day = addDays(end, i - 6)
            const long = dayLabel(day, { weekday: 'short', month: 'short', day: 'numeric' })
            return (
              <button
                type="button"
                key={day}
                className="you-bar"
                data-today={day === today || undefined}
                data-picked={day === picked || undefined}
                aria-label={`${long}: ${ms > 0 ? formatStudyTime(ms) : 'none'}`}
                onMouseEnter={() => setPicked(day)}
                onFocus={() => setPicked(day)}
                onBlur={() => setPicked(null)}
                onClick={() => setPicked(day)}
              >
                <span className="you-bar-track">
                  <span className="you-bar-fill" style={{ height: `${(ms / top) * 100}%` }} />
                </span>
                <span className="you-bar-day">{dayLabel(day, { weekday: 'narrow' })}</span>
              </button>
            )
          })}
        </div>
        <button
          type="button"
          className="you-step"
          aria-label="Week after"
          title="Week after"
          disabled={weeksBack === 0}
          onClick={() => setWeeksBack((w) => w - 1)}
        >
          ›
        </button>
        {weeksBack > 0 && (
          <p className="you-range">
            {dayLabel(addDays(end, -6), { month: 'short', day: 'numeric' })} –{' '}
            {dayLabel(end, { month: 'short', day: 'numeric' })}
          </p>
        )}
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
