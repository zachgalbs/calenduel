import { lazy, Suspense, useEffect, useState } from 'react'
import SessionTimer from './SessionTimer'
import History from './History'
import Account from './account/Account'
import PageBoundary from './PageBoundary'
import { roomFromUrl, saveRoom, savedRoom } from './room/useRoom'
import './App.css'

// The auth and database SDK is big and only the friends features use it, so
// it loads on demand rather than slowing down the timer.
const Compete = lazy(() => import('./compete/Compete'))

const PAGES = ['timer', 'history', 'friends', 'account'] as const
type Page = (typeof PAGES)[number]

function isPage(value: string | null): value is Page {
  return (PAGES as readonly (string | null)[]).includes(value)
}

// The open page is kept in the URL (?tab=...), so a refresh lands back on it.
// Invite links land on Friends and study room links on the timer, ready to
// join; the return trip from Google sign-in keeps the tab it left from.
// ?tab=compete is the page's old name, still in older links and bookmarks.
function initialPage(): Page {
  const params = new URLSearchParams(window.location.search)
  if (roomFromUrl()) return 'timer'
  if (params.has('invite')) return 'friends'
  const tab = params.get('tab')
  if (tab === 'compete') return 'friends'
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
  // The study room this tab is in, or is about to join (see room/useRoom.ts).
  // Every signed-in session has one; SessionTimer creates it on Start.
  const [room, setRoom] = useState<string | null>(() => roomFromUrl() ?? savedRoom())
  // Set by a Join click on Friends: the timer starts on arrival, while that click
  // still counts as the gesture the screen picker needs.
  const [autoStart, setAutoStart] = useState(false)
  
  useEffect(() => {
    saveRoom(room)
  }, [room])

  // replaceState rather than a new history entry: switching tabs shouldn't
  // fill up the Back button. Other parameters, like an invite code, survive.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (page === 'timer') params.delete('tab')
    else params.set('tab', page)
    // The room rides along in the URL, so a refresh stays in it.
    if (room) params.set('room', room)
    else params.delete('room')
    const query = params.toString()
    window.history.replaceState(null, '', query ? `/?${query}` : '/')
  }, [page, room])

  return (
    <>
      {!sessionActive && (
        <nav className="nav">
          <button
            type="button"
            className={page === 'timer' ? 'nav-link active' : 'nav-link'}
            onClick={() => setPage('timer')}
          >
            Timer
          </button>
          <button
            type="button"
            className={page === 'history' ? 'nav-link active' : 'nav-link'}
            onClick={() => setPage('history')}
          >
            Sessions
          </button>
          <button
            type="button"
            className={page === 'friends' ? 'nav-link active' : 'nav-link'}
            onClick={() => setPage('friends')}
          >
            Friends
          </button>
          {/* Settings-type page, so it sits apart from the tabs as an icon. */}
          <button
            type="button"
            className={page === 'account' ? 'nav-gear active' : 'nav-gear'}
            aria-label="Account"
            aria-current={page === 'account' ? 'page' : undefined}
            title="Account"
            onClick={() => setPage('account')}
          >
            <GearIcon />
          </button>
        </nav>
      )}

      {page === 'timer' && (
        <SessionTimer
          room={room}
          onRoomChange={setRoom}
          autoStart={autoStart}
          onAutoStarted={() => setAutoStart(false)}
          onActiveChange={setSessionActive}
          onSessionSaved={() => {
            setHistoryKey((k) => k + 1)
            // Best effort: the session is safe locally, and opening Friends
            // retries anything that didn't make it up. Returned, so the timer
            // knows when its live time can make way for the uploaded one.
            return import('./compete/api')
              .then(({ syncSessions }) => syncSessions())
              .catch(console.error)
          }}
        />
      )}

      {page === 'history' && <History key={historyKey} />}

      {page === 'friends' && (
        <PageBoundary>
          <Suspense fallback={null}>
            <Compete
              room={room}
              onJoin={(code) => {
                setRoom(code)
                setAutoStart(true)
                setPage('timer')
              }}
            />
          </Suspense>
        </PageBoundary>
      )}

      {page === 'account' && <Account />}
    </>
  )
}

export default App
