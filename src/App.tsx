import { useState } from 'react'
import SessionTimer from './SessionTimer'
import History from './History'
import './App.css'

type Page = 'timer' | 'history'

function App() {
  // While a session is in progress, hide the nav so the screen is just the
  // session — no distractions. SessionTimer reports its in-progress state up
  // via onActiveChange.
  const [sessionActive, setSessionActive] = useState(false)
  const [page, setPage] = useState<Page>('timer')
  const [historyKey, setHistoryKey] = useState(0)

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
        </nav>
      )}

      {page === 'timer' && (
        <SessionTimer
          onActiveChange={setSessionActive}
          onSessionSaved={() => setHistoryKey((k) => k + 1)}
        />
      )}

      {page === 'history' && <History key={historyKey} />}
    </>
  )
}

export default App
