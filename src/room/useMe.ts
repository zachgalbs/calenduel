import { useEffect, useState } from 'react'

// You, as the table shows you: your picture once signed in. Your seat is
// keyed 'me' throughout, so the room loading in doesn't walk you out and back.
export interface Me {
  id: string | null
  name: string
  avatar: string | null
}

const PLACEHOLDER: Me = { id: null, name: 'You', avatar: null }
// A failed lookup tries again this often, instead of leaving "You" up for good.
const RETRY_MS = 5_000

// One lookup for the whole page, kept once it succeeds: tables come and go
// (solo, a room, an invite) and each shouldn't start from the placeholder.
let known: Me | null = null
let lookup: Promise<Me | null> | null = null
const listeners = new Set<(me: Me) => void>()

function findMe(): Promise<Me | null> {
  lookup ??= (async () => {
    const api = await import('../compete/api')
    if (!(await api.isSignedIn())) return null
    const p = await api.ensureProfile()
    known = { id: p.id, name: p.name, avatar: p.avatar }
    return known
  })().catch((err) => {
    lookup = null // so the next try really asks again
    throw err
  })
  return lookup
}

// The profile changed on this page (new picture or name): tables follow.
export function rememberMe(patch: Partial<Me>): void {
  if (!known) return
  known = { ...known, ...patch }
  for (const tell of listeners) tell(known)
}

export function useMe(): Me {
  const [me, setMe] = useState<Me>(() => known ?? PLACEHOLDER)
  useEffect(() => {
    let closed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const tell = (m: Me) => {
      if (!closed) setMe(m)
    }
    listeners.add(tell)
    const attempt = () => {
      findMe()
        .then((m) => {
          if (m) tell(m)
        })
        .catch((err) => {
          console.error('loading your profile failed', err)
          if (!closed) retry = setTimeout(attempt, RETRY_MS)
        })
    }
    attempt()
    return () => {
      closed = true
      clearTimeout(retry)
      listeners.delete(tell)
    }
  }, [])
  return me
}
