import { lazy, Suspense, useEffect, useState } from 'react'
import PageBoundary from '../PageBoundary'
import { listSessions } from '../db'
import { formatStudyTime, localDay } from '../compete/stats'
import { ACTIVITY_WEEKS, studyStats, type DayActivity, type StudyStats } from './stats'
import SubjectTally from '../subjects/SubjectTally'
import './Account.css'

// Stats come from this device and need no sign-in, so only the profile half
// waits on the auth and database SDK.
const ProfileSection = lazy(() => import('./ProfileSection'))
const FeedbackSection = lazy(() => import('./FeedbackSection'))
const SignOut = lazy(() => import('./SignOut'))

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`
}

function dayLabel(day: string): string {
  // Noon, so the label can't slip onto the neighbouring date in any timezone.
  return new Date(`${day}T12:00:00`).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

// One square per day, a column per week. Shading is relative to your own best
// day in the window, so the grid shows your pattern rather than a fixed target.
function Activity({ activity }: { activity: DayActivity[] }) {
  const max = Math.max(...activity.map((d) => d.ms))
  return (
    <div
      className="activity"
      role="img"
      aria-label={`Study time per day over the last ${ACTIVITY_WEEKS} weeks`}
    >
      {activity.map((d) => (
        <span
          key={d.day}
          className="activity-day"
          data-level={d.ms > 0 ? Math.ceil((d.ms / max) * 4) : 0}
          title={`${dayLabel(d.day)}: ${formatStudyTime(d.ms)}`}
        />
      ))}
    </div>
  )
}

function Stats({ stats }: { stats: StudyStats }) {
  const figures = [
    ['Today', formatStudyTime(stats.todayMs)],
    ['Last 7 days', formatStudyTime(stats.weekMs)],
    ['All time', formatStudyTime(stats.totalMs)],
    ['Sessions', String(stats.sessions)],
    ['Streak', days(stats.streak)],
    ['Best streak', days(stats.bestStreak)],
    ['Longest session', formatStudyTime(stats.longestSessionMs)],
    ['Best day', formatStudyTime(stats.bestDayMs)],
  ]
  return (
    <>
      <dl className="figures">
        {figures.map(([label, value]) => (
          <div key={label} className="figure">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Activity activity={stats.activity} />
    </>
  )
}

export default function Account() {
  const [stats, setStats] = useState<StudyStats | null>(null)

  useEffect(() => {
    let closed = false
    listSessions().then((sessions) => {
      if (!closed) setStats(studyStats(sessions, localDay(Date.now())))
    })
    return () => {
      closed = true
    }
  }, [])

  return (
    <main className="account">
      <PageBoundary>
        <Suspense fallback={null}>
          <ProfileSection />
        </Suspense>
      </PageBoundary>

      <section className="account-section">
        <h2>Stats</h2>
        {stats && <Stats stats={stats} />}
      </section>

      <section className="account-section">
        <h2>Subjects</h2>
        <SubjectTally />
      </section>

      <PageBoundary>
        <Suspense fallback={null}>
          <FeedbackSection />
        </Suspense>
      </PageBoundary>

      <PageBoundary>
        <Suspense fallback={null}>
          <SignOut />
        </Suspense>
      </PageBoundary>
    </main>
  )
}
