import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { startCamera, stopStream } from '../media/capture'
import { startTimelapse, type TimelapseRecorder } from '../media/timelapse'

// Encapsulates the camera + timelapse lifecycle for a study session. The stream
// lives in STATE so that setting it mounts the <video>; the effect then attaches
// the stream and starts frame sampling only once the element is actually in the
// DOM. (Attaching in the click handler would race a not-yet-mounted ref.)

export interface RecorderHandle {
  videoRef: RefObject<HTMLVideoElement | null>
  // Non-null while a session is live — gate the preview <video> on this.
  stream: MediaStream | null
  // Acquire the camera and start recording. Rejects if access is denied or no
  // camera exists, which the caller uses to block the session from starting.
  begin: () => Promise<void>
  // Stop recording, release the camera, and resolve with the timelapse clip.
  end: () => Promise<Blob | null>
}

export function useTimelapseRecorder(): RecorderHandle {
  const videoRef = useRef<HTMLVideoElement>(null)
  const timelapseRef = useRef<TimelapseRecorder | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)

  // Attach + sample once the <video> has mounted (effects run post-commit, so
  // videoRef.current is guaranteed here). Cleanup covers both normal stop and
  // unmount-mid-session, so the camera light never lingers.
  useEffect(() => {
    const video = videoRef.current
    if (!stream || !video) return
    video.srcObject = stream
    const timelapse = startTimelapse(video)
    timelapseRef.current = timelapse
    return () => {
      timelapse.cancel()
      timelapseRef.current = null
      stopStream(stream)
    }
  }, [stream])

  const begin = useCallback(async () => {
    const live = await startCamera() // throws if denied/unavailable
    setStream(live)
  }, [])

  const end = useCallback(async () => {
    // stop() clears the sampling timer synchronously, so releasing the camera
    // right after is safe — the light goes off while encoding runs.
    const encoding =
      timelapseRef.current?.stop() ?? Promise.resolve<Blob | null>(null)
    if (stream) stopStream(stream)
    const blob = await encoding
    setStream(null) // unmounts the preview and fires the effect cleanup
    return blob
  }, [stream])

  return { videoRef, stream, begin, end }
}
