import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchTodayEvents,
  hasValidToken,
  type CalendarEvent,
} from './googleCalendar'
import SessionTimer from './SessionTimer'
import './App.css'

const todayLabel = new Date().toLocaleDateString([], {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

function formatTime(event: CalendarEvent): string {
  if (!event.start.dateTime) return 'all day'
  return new Date(event.start.dateTime)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .replace(' AM', ' am')
    .replace(' PM', ' pm')
}

function App() {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)
  // Start in the loading state when a token is already cached: the auto-load
  // effect below is about to fetch, so the button should read "Loading…" from
  // the first paint. Lazy initializer so the storage read runs once.
  const [loading, setLoading] = useState(() => hasValidToken())
  const [error, setError] = useState<string | null>(null)

  // Shared fetch path for both the button and the auto-load effect. Every
  // setState happens AFTER the await, so calling this from an effect doesn't
  // trigger a synchronous cascading render. The button handler owns the
  // synchronous "entering loading" state instead (see handleConnect).
  const loadEvents = useCallback(async () => {
    try {
      setEvents(await fetchTodayEvents())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  // On load, if a valid token is already cached, restore the event list without
  // a click — and crucially without the OAuth popup, since hasValidToken() only
  // checks storage. The ref guard makes this fire once even under StrictMode's
  // dev double-invoke, so we don't double-fetch. loading was already seeded true
  // by the lazy initializer above, so there's no setState needed here on entry.
  const didAutoLoad = useRef(false)
  useEffect(() => {
    if (didAutoLoad.current) return
    didAutoLoad.current = true
    // loadEvents only setStates after its await, so this is an async data fetch,
    // not a synchronous cascading render. The lint rule can't see past the call
    // boundary to know that, so it's a false positive here — disabled with cause.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (hasValidToken()) loadEvents()
  }, [loadEvents])

  // Button click: synchronously enter the loading state (fine in an event
  // handler), then run the shared fetch.
  function handleConnect() {
    setLoading(true)
    setError(null)
    loadEvents()
  }

  // While a session is in progress, hide the whole calendar block so the screen
  // is just the session — no event list, no distractions. SessionTimer reports
  // its in-progress state up via onActiveChange.
  const [sessionActive, setSessionActive] = useState(false)

  return (
    <>
      {!sessionActive && (
      <main className="calendar">
        <h1>Today</h1>
        <p className="subtitle">{todayLabel}</p>

        {/* Only shown until events load — no Refresh button, since the user can
            just reload the page (which auto-restores via the cached token). */}
        {!events && (
          <button type="button" onClick={handleConnect} disabled={loading}>
            {loading ? 'Loading…' : 'Connect Google Calendar'}
          </button>
        )}

        {error && <p className="error">{error}</p>}

        {events && events.length === 0 && (
          <p className="empty">Nothing on the calendar today.</p>
        )}

        {events && events.length > 0 && (
          <ul className="event-list">
            {events.map((event) => (
              <li key={event.id}>
                <span className="event-time">{formatTime(event)}</span>
                <span className="event-title">{event.summary ?? '(no title)'}</span>
              </li>
            ))}
          </ul>
        )}
      </main>
      )}

      <SessionTimer events={events} onActiveChange={setSessionActive} />
    </>
  )
}

export default App
