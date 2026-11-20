import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { consumeHelperParam } from './media/ipadHelper'
import { SEND_PARAM } from './move/move'
import SendSessions from './move/SendSessions'

consumeHelperParam()

// ?send=1: the small window the app's other address opens to fetch this
// address's sessions (see move/). It shows only that, never the app.
const sending = new URLSearchParams(window.location.search).has(SEND_PARAM)

createRoot(document.getElementById('root')!).render(
  <StrictMode>{sending ? <SendSessions /> : <App />}</StrictMode>,
)
