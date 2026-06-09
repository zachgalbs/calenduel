import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { startCamera, startScreen, stopStream } from '../media/capture'
import { startTimelapse, type TimelapseRecorder } from '../media/timelapse'

// Encapsulates the camera + screen + timelapse lifecycle for a study session.
// Both streams live in STATE so that setting them mounts the two <video>
// elements; the effect then attaches the streams and starts frame sampling only
// once the elements are actually in the DOM. (Attaching in the click handler
// would race not-yet-mounted refs.)

interface Streams {
  face: MediaStream
  screen: MediaStream
}

export interface RecorderHandle {
  faceVideoRef: RefObject<HTMLVideoElement | null>
  screenVideoRef: RefObject<HTMLVideoElement | null>
  // True once both feeds are live — gate the preview on this.
  streaming: boolean
  // Acquire screen + camera and start recording. Rejects if either is denied,
  // which the caller uses to block the session from starting.
  begin: () => Promise<void>
  // Stop recording, release both streams, and resolve with the timelapse clip.
  end: () => Promise<Blob | null>
}

// onInterrupted fires when the user ends the screen share from the browser's own
// "Stop sharing" UI mid-session — the caller should treat it like pressing Stop.
export function useTimelapseRecorder(onInterrupted: () => void): RecorderHandle {
  const faceVideoRef = useRef<HTMLVideoElement>(null)
  const screenVideoRef = useRef<HTMLVideoElement>(null)
  const timelapseRef = useRef<TimelapseRecorder | null>(null)
  const [streams, setStreams] = useState<Streams | null>(null)

  // Keep the latest callback in a ref so the track listener (attached once per
  // session) always calls the current handler without re-running the effect.
  const interruptedRef = useRef(onInterrupted)
  useEffect(() => {
    interruptedRef.current = onInterrupted
  }, [onInterrupted])

  // Attach + sample once both <video>s have mounted (effects run post-commit, so
  // the refs are guaranteed here). Cleanup covers normal stop and unmount, so
  // neither the camera light nor the screen share ever lingers.
  useEffect(() => {
    const face = faceVideoRef.current
    const screen = screenVideoRef.current
    if (!streams || !face || !screen) return
    face.srcObject = streams.face
    screen.srcObject = streams.screen
    const timelapse = startTimelapse(face, screen)
    timelapseRef.current = timelapse

    // The screen track ends if the user clicks the browser's "Stop sharing".
    const screenTrack = streams.screen.getVideoTracks()[0]
    const handleEnded = () => interruptedRef.current()
    screenTrack.addEventListener('ended', handleEnded)

    return () => {
      screenTrack.removeEventListener('ended', handleEnded)
      timelapse.cancel()
      timelapseRef.current = null
      stopStream(streams.face)
      stopStream(streams.screen)
    }
  }, [streams])

  const begin = useCallback(async () => {
    // Screen first: getDisplayMedia needs the click's transient activation, and
    // awaiting the camera first would spend it. If the user cancels the screen
    // picker this throws and we never touch the camera.
    const screen = await startScreen()
    let face: MediaStream
    try {
      face = await startCamera()
    } catch (err) {
      stopStream(screen) // don't leave the screen share running on camera denial
      throw err
    }
    setStreams({ face, screen })
  }, [])

  const end = useCallback(async () => {
    // stop() clears the sampling timer synchronously, so releasing the streams
    // right after is safe — the lights go off while the final flush runs.
    const encoding =
      timelapseRef.current?.stop() ?? Promise.resolve<Blob | null>(null)
    if (streams) {
      stopStream(streams.face)
      stopStream(streams.screen)
    }
    const blob = await encoding
    setStreams(null) // unmounts the previews and fires the effect cleanup
    return blob
  }, [streams])

  return {
    faceVideoRef,
    screenVideoRef,
    streaming: streams !== null,
    begin,
    end,
  }
}
