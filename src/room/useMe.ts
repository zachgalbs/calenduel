import { useEffect, useState } from 'react'

// You, as the table shows you: your picture once signed in. Your seat is
// keyed 'me' throughout, so the room loading in doesn't walk you out and back.
export function useMe(): { id: string | null; name: string; avatar: string | null } {
  const [me, setMe] = useState<{ id: string | null; name: string; avatar: string | null }>({
    id: null,
    name: 'You',
    avatar: null,
  })
  useEffect(() => {
    let closed = false
    import('../compete/api')
      .then(async ({ isSignedIn, ensureProfile }) => {
        if (!(await isSignedIn())) return
        const p = await ensureProfile()
        if (!closed) setMe({ id: p.id, name: p.name, avatar: p.avatar })
      })
      .catch(() => {})
    return () => {
      closed = true
    }
  }, [])
  return me
}
