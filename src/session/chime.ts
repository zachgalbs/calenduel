// A soft "you reached your goal" chime, synthesized with the Web Audio API so
// there's no audio asset to ship. Deliberately gentle — a calm rising fifth,
// not an alarm — because the whole point of the soft goal is to *not* jar you
// out of focus.

let ctx: AudioContext | null = null

// Create/unlock the audio context. MUST be called from a user gesture (the
// Start click), because browsers suspend audio created outside one. Priming it
// at Start means the goal chime — which fires later, with no gesture — can play.
export function primeAudio(): void {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
}

export function playChime(): void {
  if (!ctx) return // never primed (Start wasn't clicked) — stay silent
  const now = ctx.currentTime
  const notes = [880, 1318.5] // A5 → E6, a calm rising fifth

  notes.forEach((freq, i) => {
    const osc = ctx!.createOscillator()
    const gain = ctx!.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq

    // Each note: quick fade-in, long gentle decay. Staggered slightly so they
    // ring as a pair rather than a chord.
    const t = now + i * 0.18
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.15, t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9)

    osc.connect(gain).connect(ctx!.destination)
    osc.start(t)
    osc.stop(t + 0.95)
  })
}
