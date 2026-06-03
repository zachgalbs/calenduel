// Browser-only Google Calendar (readonly) integration using the GIS token flow.
//
// Two phases:
//   1. Authorization  — getAccessToken(): get a bearer token via GIS (popup/consent).
//   2. Resource access — fetchTodayEvents(): plain fetch() with Authorization: Bearer.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
const STORAGE_KEY = 'calenduel.token'

// Re-request the token this many ms before it actually expires, so a request
// can't die mid-flight right at the boundary.
const EXPIRY_SKEW_MS = 60_000

export interface CalendarEvent {
  id: string
  summary?: string
  // Timed events use dateTime; all-day events use date.
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
}

interface StoredToken {
  accessToken: string
  expiresAt: number // epoch ms
}

function isGisReady(): boolean {
  return !!window.google?.accounts?.oauth2
}

function getStoredToken(): string | null {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const token = JSON.parse(raw) as StoredToken
    if (Date.now() >= token.expiresAt - EXPIRY_SKEW_MS) return null
    return token.accessToken
  } catch {
    return null
  }
}

function storeToken(accessToken: string, expiresIn: number): void {
  const token: StoredToken = {
    accessToken,
    // The API gives us a lifetime (seconds), not an absolute time, so we
    // compute and store the expiry instant ourselves.
    expiresAt: Date.now() + expiresIn * 1000,
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(token))
}

// Phase 1: ask GIS for a fresh access token. Shows the consent popup, or
// returns silently if the user's Google session is still alive and consented.
// There is no refresh token in the browser flow — this re-request IS the refresh.
function requestToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!isGisReady()) {
      reject(new Error('Google Identity Services not loaded yet'))
      return
    }
    if (!CLIENT_ID) {
      reject(new Error('Missing VITE_GOOGLE_CLIENT_ID — set it in .env.local'))
      return
    }

    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error))
          return
        }
        storeToken(response.access_token, response.expires_in)
        resolve(response.access_token)
      },
      error_callback: (error) =>
        reject(new Error(error.message ?? 'Authorization was cancelled or failed')),
    })

    client.requestAccessToken()
  })
}

// Returns a usable token: the stored one if still valid, otherwise a fresh one.
async function getAccessToken(): Promise<string> {
  return getStoredToken() ?? (await requestToken())
}

// Whether a usable (non-expired) token is already cached. Lets the UI restore
// its event list on page load without triggering the OAuth popup — a silent
// check, unlike getAccessToken() which would prompt when nothing is stored.
export function hasValidToken(): boolean {
  return getStoredToken() !== null
}

// Start/end of "today" in the user's local timezone, as RFC3339 instants.
function todayBounds(): { timeMin: string; timeMax: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  end.setDate(start.getDate() + 1)
  return { timeMin: start.toISOString(), timeMax: end.toISOString() }
}

function eventsUrl(): string {
  const { timeMin, timeMax } = todayBounds()
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true', // expand recurring events into individual instances
    orderBy: 'startTime',
  })
  return `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`
}

function getEvents(token: string): Promise<Response> {
  return fetch(eventsUrl(), { headers: { Authorization: `Bearer ${token}` } })
}

// Phase 2: fetch today's events. If the token is rejected (401), drop it,
// re-request once, and retry.
export async function fetchTodayEvents(): Promise<CalendarEvent[]> {
  let token = await getAccessToken()
  let res = await getEvents(token)

  if (res.status === 401) {
    sessionStorage.removeItem(STORAGE_KEY)
    token = await requestToken()
    res = await getEvents(token)
  }

  if (!res.ok) {
    throw new Error(`Calendar API error: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as { items?: CalendarEvent[] }
  return data.items ?? []
}
