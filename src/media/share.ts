// Sharing the finished timelapse.
//
// Two paths, because the browser gives us two very different capabilities:
//   - download:  works everywhere, produces a file the user attaches manually.
//   - Web Share: opens the OS share sheet (iMessage, WhatsApp, ...) with the
//                actual video file attached. Best on Apple / mobile; often
//                absent on desktop Chrome. We feature-detect before offering it.
//
// Note: the browser cannot target a specific iMessage group chat — it can only
// hand the file to the system share sheet, where the user picks Messages and
// then the chat. That's as close as the web platform gets.

// Pick a file extension that matches whatever container MediaRecorder produced.
function extensionFor(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm'
}

export function timelapseName(blob: Blob): string {
  return `calenduel-timelapse.${extensionFor(blob.type)}`
}

// Web Share requires File objects (not bare Blobs), so wrap it.
export function blobToFile(blob: Blob, filename: string): File {
  return new File([blob], filename, { type: blob.type })
}

// Whether this browser can share THIS file via the native share sheet.
// canShare with a files payload is the only reliable signal — plain
// `'share' in navigator` lies (text sharing works, file sharing may not).
export function canShareFile(file: File): boolean {
  return (
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  )
}

// Trigger a plain download of the blob.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Open the native share sheet with the file. Resolves when the sheet is done.
// A dismissed sheet (AbortError) is a normal user action, not a failure.
export async function shareFile(file: File): Promise<void> {
  try {
    await navigator.share({ files: [file], title: 'Calenduel timelapse' })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return
    throw err
  }
}
