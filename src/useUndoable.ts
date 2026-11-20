import { useEffect, useRef, useState } from 'react'

const UNDO_MS = 5000

// Something removed with a moment to take it back: start() hides it and
// commits after a few seconds unless undo() comes first. Leaving the page
// commits at once, so a removal never silently fails to happen.
export function useUndoable(commit: () => Promise<void>) {
  const [pending, setPending] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const commitRef = useRef(commit)
  const pendingRef = useRef(false)
  useEffect(() => {
    commitRef.current = commit
  })

  function fire() {
    clearTimeout(timerRef.current)
    if (!pendingRef.current) return
    pendingRef.current = false
    void commitRef.current().catch(() => setPending(false))
  }

  useEffect(() => () => fire(), [])

  return {
    pending,
    start() {
      pendingRef.current = true
      setPending(true)
      timerRef.current = setTimeout(fire, UNDO_MS)
    },
    undo() {
      clearTimeout(timerRef.current)
      pendingRef.current = false
      setPending(false)
    },
  }
}
