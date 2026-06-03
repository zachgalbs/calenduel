// Timelapse generation — browser-only, dependency-free.
//
// A timelapse is just a video played back faster than it was recorded. Rather
// than record the full-rate video and drop frames afterward (which would mean
// decoding the whole thing), we sample sparse frames *during* capture, then
// replay them into a new video at normal speed.
//
//   speedup = PLAYBACK_FPS / SAMPLE_RATE
//
// At 2 sampled frames/sec replayed at 30 fps that's 15×: a 60s recording
// collects 120 frames and plays back in 4s.

import { pickMimeType } from './capture'

const SAMPLE_RATE = 2    // frames captured per second of real time
const PLAYBACK_FPS = 30  // frames shown per second on playback → 15× speedup
const JPEG_QUALITY = 0.7 // sampled frames stored compressed, to save memory

export interface TimelapseRecorder {
  // End sampling and encode the collected frames into one video Blob.
  stop: () => Promise<Blob>
  // Abandon sampling without encoding — for teardown paths (e.g. the component
  // unmounting mid-recording) that don't need the clip. Safe to call after
  // stop(), and safe to call more than once.
  cancel: () => void
}

// Begin sampling frames from a live, playing <video> element. Returns a handle
// whose stop() clears the sampler (synchronously) and produces the timelapse.
export function startTimelapse(video: HTMLVideoElement): TimelapseRecorder {
  // Frames are stored as compressed JPEG blobs, not raw bitmaps: a 720p raw
  // frame is ~3.7 MB, so minutes of footage would exhaust memory. JPEGs at
  // this quality are ~100 KB each.
  const frames: Blob[] = []
  const scratch = document.createElement('canvas')
  const ctx = scratch.getContext('2d')!

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (!video.videoWidth) return // skip until the feed actually has pixels
    scratch.width = video.videoWidth
    scratch.height = video.videoHeight
    ctx.drawImage(video, 0, 0)
    scratch.toBlob(
      (blob) => {
        if (blob) frames.push(blob)
      },
      'image/jpeg',
      JPEG_QUALITY,
    )
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
    stop() {
      // Runs synchronously before the first await in encode(), so the caller
      // can safely release the camera the moment stop() returns.
      stopSampling()
      return encode(frames)
    },
    cancel() {
      stopSampling()
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Replay sampled frames into a canvas at PLAYBACK_FPS and record that canvas.
// captureStream(0) gives manual control: draw a frame, ask the track to grab
// exactly that one, wait one playback-frame, repeat. The result plays at
// PLAYBACK_FPS, so output duration = frames / PLAYBACK_FPS.
async function encode(frames: Blob[]): Promise<Blob> {
  if (frames.length === 0) return new Blob([])

  const first = await createImageBitmap(frames[0])
  const canvas = document.createElement('canvas')
  canvas.width = first.width
  canvas.height = first.height
  const ctx = canvas.getContext('2d')!
  first.close()

  const stream = canvas.captureStream(0)
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack
  const mimeType = pickMimeType()
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () =>
      resolve(new Blob(chunks, { type: recorder.mimeType }))
  })

  recorder.start()
  const frameDelay = 1000 / PLAYBACK_FPS
  for (const blob of frames) {
    const bitmap = await createImageBitmap(blob)
    ctx.drawImage(bitmap, 0, 0)
    track.requestFrame()
    bitmap.close()
    await sleep(frameDelay)
  }
  recorder.stop()
  return done
}
