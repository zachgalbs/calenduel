// Browser camera capture via getUserMedia.
//
// Video-only by design: the end product is a silent timelapse, so we never
// request the microphone — one less permission prompt, and no audio track to
// manage or merge later.

// Ask the browser for the webcam. Triggers the permission prompt on first use;
// resolves once the user grants access (or rejects with their denial reason).
export async function startCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera capture is not supported in this browser')
  }
  return navigator.mediaDevices.getUserMedia({ video: true, audio: false })
}

// Stop every track so the OS releases the camera and the indicator light turns
// off. A MediaStream stays "live" until each of its tracks is individually
// stopped — dropping the reference alone is not enough.
export function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop())
}

// Browsers disagree on which container/codec they'll record. Prefer MP4 (H.264):
// it's the format iMessage and most native apps accept, and recent Chrome can
// record it directly. Fall back to WebM where MP4 recording isn't available.
// undefined lets MediaRecorder choose. Exported because both live capture and
// timelapse encoding need it.
export function pickMimeType(): string | undefined {
  const candidates = [
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  return candidates.find((type) => MediaRecorder.isTypeSupported(type))
}
