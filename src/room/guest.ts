// A signed-out visitor at a friend's table. Their browser makes up a secret
// once and keeps it; with a room's code, that's all they act with. Kept in
// localStorage so a refresh or a second session finds the same seat.
const KEY = 'calenduel.guest'

let fallback: string | null = null

export function guestSecret(): string {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) return saved
    const made = crypto.randomUUID()
    localStorage.setItem(KEY, made)
    return made
  } catch {
    // Storage blocked: the seat lasts as long as the page.
    fallback ??= crypto.randomUUID()
    return fallback
  }
}
