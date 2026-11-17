import { lazy, Suspense, useEffect, useState } from 'react'
import SessionTimer from './SessionTimer'
import History from './History'
import Account from './account/Account'
import { roomFromUrl, saveRoom, savedRoom } from './room/useRoom'
import './App.css'

// The auth and database SDK is big and only competition features use it, so
// it loads on demand rather than slowing down the timer.
const Compete = lazy(() => import('./compete/Compete'))
const Lobby = lazy(() => import('./room/Lobby'))

const PAGES = ['timer', 'history', 'room', 'compete', 'account'] as const
type Page = (typeof PAGES)[number]

function isPage(value: string | null): value is Page {
  return (PAGES as readonly (string | null)[]).includes(value)
}

// The open page is kept in the URL (?tab=...), so a refresh lands back on it.
// Invite links land on Compete and group study links in that group study's
// lobby; the return trip from Google sign-in keeps the tab it left from.
function initialPage(): Page {
  const params = new URLSearchParams(window.location.search)
  if (roomFromUrl()) return 'room'
  if (params.has('invite')) return 'compete'
  const tab = params.get('tab')
  return isPage(tab) ? tab : 'timer'
}

// The Lucide "settings" icon (ISC licence), drawn in the current text colour.
function GearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function App() {
  // While a session is in progress, hide the nav so the screen is just the
  // session — no distractions. SessionTimer reports its in-progress state up
  // via onActiveChange.
  const [sessionActive, setSessionActive] = useState(false)
  const [page, setPage] = useState<Page>(initialPage)
  const [historyKey, setHistoryKey] = useState(0)
  // The group study this tab is in, if any (see room/useRoom.ts).
  const [room, setRoom] = useState<string | null>(() => roomFromUrl() ?? savedRoom())
  // Set by the lobby's Start studying click: the timer starts on arrival, while
  // that click still counts as the gesture the screen picker needs.
  const [autoStart, setAutoStart] = useState(false)
  const shownPage = page === 'room' && !room ? 'compete' : page

  useEffect(() => {
    saveRoom(room)
  }, [room])

  // replaceState rather than a new history entry: switching tabs shouldn't
  // fill up the Back button. Other parameters, like an invite code, survive.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (shownPage === 'timer') params.delete('tab')
    else params.set('tab', shownPage)
    // The room rides along in the URL, so a refresh stays in it.
    if (room) params.set('room', room)
    else params.delete('room')
    const query = params.toString()
    window.history.replaceState(null, '', query ? `/?${query}` : '/')
  }, [shownPage, room])

  return (
    <>
      {!sessionActive && (
        <nav className="nav">
          <button
            type="button"
            className={shownPage === 'timer' ? 'nav-link active' : 'nav-link'}
            onClick={() => setPage('timer')}
          >
            Timer
          </button>
          <button
            type="button"
            className={shownPage === 'history' ? 'nav-link active' : 'nav-link'}
            onClick={() => setPage('history')}
          >
            Sessions
          </button>
          {room && (
            <button
              type="button"
              className={shownPage === 'room' ? 'nav-link active' : 'nav-link'}
              onClick={() => setPage('room')}
            >
              <span className="nav-live" aria-hidden="true" />
              Group study
            </button>
          )}
          <button
            type="button"
            className={shownPage === 'compete' ? 'nav-link active' : 'nav-link'}
            onClick={() => setPage('compete')}
          >
            Compete
          </button>
          {/* Settings-type page, so it sits apart from the tabs as an icon. */}
          <button
            type="button"
            className={shownPage === 'account' ? 'nav-gear active' : 'nav-gear'}
            aria-label="Account"
            shownPage-current={page === 'account' ? 'page' : undefined}
            title="Account"
            onClick={() => setPage('account')}
          >
            <GearIcon />
          </button>
        </nav>
      )}

      {shownPage === 'timer' && (
        <SessionTimer
          room={room}
          autoStart={autoStart}
          onAutoStarted={() => setAutoStart(false)}
          onLeaveRoom={() => setRoom(null)}
          onActiveChange={setSessionActive}
          onSessionSaved={() => {
            setHistoryKey((k) => k + 1)
            // Best effort: the session is safe locally, and opening Compete
            // retries anything that didn't make it up.
            import('./compete/api')
              .then(({ syncSessions }) => syncSessions())
              .catch(console.error)
          }}
        />
      )}

      {shownPage === 'history' && <History key={historyKey} />}

      {shownPage === 'room' && room && (
        <Suspense fallback={null}>
          <Lobby
            code={room}
            onStudy={() => {
              setAutoStart(true)
              setPage('timer')
            }}
            onLeave={() => {
              setRoom(null)
              setPage('compete')
            }}
          />
        </Suspense>
      )}

      {shownPage === 'compete' && (
        <Suspense fallback={null}>
          <Compete
            room={room}
            onOpenRoom={(code) => {
              setRoom(code)
              setPage('room')
            }}
          />
        </Suspense>
      )}

      {shownPage === 'account' && <Account />}
    </>
  )
}

export default App
