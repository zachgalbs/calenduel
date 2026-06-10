// Timelapse generation — browser-only via WebCodecs.
//
// A timelapse is just a video played back faster than it was recorded. We
// sample sparse frames during capture and encode each one the *instant* we grab
// it, assigning a virtual 30 fps timeline (frame i sits at i·33ms) so the
// finished clip is sped up:
//
//   speedup = PLAYBACK_FPS / SAMPLE_RATE
//
// At 1 sampled frame/sec stamped 33ms apart that's 30×. Because every frame is
// encoded live as it's sampled, Stop only has to flush the last few frames and
// finalize the container — near-instant, no matter how long the session ran.
//
// Each frame is a composite: the shared screen fills the frame, with the webcam
// face drawn small in the bottom-right (picture-in-picture), so a viewer can see
// both what you were working on and that you were there.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

const SAMPLE_RATE = 1    // frames captured per second of real time
const PLAYBACK_FPS = 30  // frames shown per second on playback → 30× speedup
const FRAME_DURATION_US = Math.round(1_000_000 / PLAYBACK_FPS) // µs per frame
// One keyframe every ~2s of output, so scrubbing/seeking the clip works. Frame
// 0 lands on this too, satisfying the "first frame must be a keyframe" rule.
const KEYFRAME_INTERVAL = PLAYBACK_FPS * 2
// Screen capture is mostly text; a low bitrate smears it into mush, which defeats
// the "see what they were doing" point. Higher = more legible but bigger file.
const BITRATE = 4_000_000
// Cap the longer side. A Retina screen reports e.g. 3024×1964 — far more than a
// shared timelapse needs, and it would balloon the file. Capping also keeps us
// safely inside the codec level's max frame size (see CODEC).
const MAX_DIMENSION = 1920
// H.264 High profile, level 5.1: handles anything up to ~4K, so any screen
// scaled to MAX_DIMENSION fits with headroom regardless of aspect ratio. (Level
// 3.1 — the old default — tops out at 1280×720, which Retina screens blow past.)
const CODEC = 'avc1.640033'

// Face inset (picture-in-picture): fraction of the screen width, pinned to the
// bottom-right with a margin and a dark frame so it reads against busy content.
const INSET_FRACTION = 0.25
const INSET_MARGIN = 16
const INSET_BORDER = 3

export interface TimelapseRecorder {
  // End sampling and finalize the live-encoded frames into one video Blob.
  stop: () => Promise<Blob>
  // Abandon without finalizing — for teardown paths (e.g. the component
  // unmounting mid-recording) that don't need the clip. Safe to call after
  // stop(), and safe to call more than once.
  cancel: () => void
}

// Scale (down only) so the longer side fits MAX_DIMENSION, keeping aspect ratio,
// and round to even — H.264 4:2:0 needs even dimensions, and an oversized frame
// blows past the codec level's max coded area (encode() then throws).
function fitDimensions(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(w, h))
  return {
    width: Math.round(w * scale) & ~1,
    height: Math.round(h * scale) & ~1,
  }
}

// Begin sampling composite frames from two live <video> elements (the shared
// screen and the webcam face), encoding each one as it's captured. Returns a
// handle whose stop() flushes and produces the clip.
export function startTimelapse(
  face: HTMLVideoElement,
  screen: HTMLVideoElement,
): TimelapseRecorder {
  // Encoder + muxer are built lazily on the first frame that actually has
  // pixels: configure() needs real dimensions, and the feed reports 0×0 until
  // it's playing. Both stay null until then.
  let muxer: Muxer<ArrayBufferTarget> | null = null
  let encoder: VideoEncoder | null = null
  let frameCount = 0

  // Frames are composited through this canvas (sized to the capped, even output
  // dimensions) so the VideoFrame always matches the encoder's configured size.
  const scratch = document.createElement('canvas')
  const ctx = scratch.getContext('2d')!

  function setup(width: number, height: number) {
    scratch.width = width
    scratch.height = height
    const mux = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width, height },
      fastStart: 'in-memory', // moov box up front → the Blob is seekable/playable
    })
    const enc = new VideoEncoder({
      // Forward meta untouched — it carries the codec description the muxer needs.
      output: (chunk, meta) => mux.addVideoChunk(chunk, meta),
      error: (e) => {
        console.error('timelapse encode error', e)
        stopSampling() // a fatal error closes the codec; stop feeding it
      },
    })
    enc.configure({ codec: CODEC, width, height, bitrate: BITRATE })
    muxer = mux
    encoder = enc
  }

  // The webcam, scaled down and dropped into the bottom-right over the screen.
  function drawFaceInset() {
    const insetW = Math.round(scratch.width * INSET_FRACTION)
    const insetH = Math.round(insetW * (face.videoHeight / face.videoWidth))
    const x = scratch.width - insetW - INSET_MARGIN
    const y = scratch.height - insetH - INSET_MARGIN
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.fillRect(
      x - INSET_BORDER,
      y - INSET_BORDER,
      insetW + INSET_BORDER * 2,
      insetH + INSET_BORDER * 2,
    )
    ctx.drawImage(face, x, y, insetW, insetH)
  }

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (!screen.videoWidth) return // canvas size comes from the screen feed
    if (!encoder) {
      const { width, height } = fitDimensions(screen.videoWidth, screen.videoHeight)
      setup(width, height)
    }
    // A fatal encode error flips the codec to 'closed'; bail rather than throw
    // on every tick.
    if (encoder!.state !== 'configured') {
      stopSampling()
      return
    }
    ctx.drawImage(screen, 0, 0, scratch.width, scratch.height)
    if (face.videoWidth) drawFaceInset() // skip the inset until the camera has pixels
    const frame = new VideoFrame(scratch, {
      timestamp: frameCount * FRAME_DURATION_US,
      duration: FRAME_DURATION_US,
    })
    try {
      encoder!.encode(frame, { keyFrame: frameCount % KEYFRAME_INTERVAL === 0 })
    } finally {
      frame.close() // always release the GPU buffer, even if encode() throws
    }
    frameCount++
  }, 1000 / SAMPLE_RATE)

  // Clearing the sampling interval, idempotently — both stop() and cancel()
  // funnel through here, so calling them in any order is safe.
  function stopSampling() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    async stop() {
      // Clears the sampler synchronously (before the first await), so the caller
      // can safely release the streams the moment stop() returns.
      stopSampling()
      // Nothing usable: never sampled, or the codec died mid-session — you can't
      // flush a closed encoder, so return an empty clip rather than throw.
      if (!encoder || !muxer || encoder.state !== 'configured') return new Blob([])
      await encoder.flush()
      muxer.finalize()
      const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' })
      encoder.close()
      return blob
    },
    cancel() {
      stopSampling()
      // Tear down without finalizing. encoder may be null (no frame ever landed)
      // or already closed by a preceding stop()/error — guard both.
      if (encoder && encoder.state !== 'closed') encoder.close()
    },
  }
}
