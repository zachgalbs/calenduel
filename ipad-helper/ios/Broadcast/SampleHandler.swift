// The broadcast extension: iPadOS hands it the whole screen while a "Calenduel"
// screen broadcast runs (started from the app or Control Center). It connects to
// the paired Mac helper and sends JPEG frames, but only while the Mac says a
// session wants them; otherwise it just holds the newest screen and encodes
// nothing, to spare the iPad's battery.
import CoreImage
import Network
import ReplayKit

private let MAX_SIDE: CGFloat = 1280 // long side; the timelapse pane is smaller
private let MAX_FPS = 2.0 // the page takes one a second

final class SampleHandler: RPBroadcastSampleHandler {
  private let queue = DispatchQueue(label: "calenduel.broadcast")
  private let ci = CIContext(options: [.cacheIntermediates: false])

  // Guards `last` and `dirty`: written for every screen update, from ReplayKit's thread.
  private let lock = NSLock()
  private var last: (pixels: CVPixelBuffer, orientation: CGImagePropertyOrientation)?
  private var dirty = false // `last` hasn't been sent yet
  private var pumpQueued = false

  // Touched on `queue` only.
  private var code = ""
  private var finder: MacFinder?
  private var conn: NWConnection?
  private var finished = false
  private var wanted = false
  private var sending = false
  private var flushQueued = false
  private var lastEncode: CFAbsoluteTime = 0

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    guard let code = PairingStore.code else {
      return stop("Open Calenduel Link and pair it with your Mac first.")
    }
    queue.async {
      self.code = code
      self.findMac()
    }
  }

  override func broadcastFinished() {
    queue.sync {
      finished = true
      finder?.cancel()
      conn?.cancel()
    }
    lock.lock(); last = nil; lock.unlock()
  }

  override func processSampleBuffer(_ sample: CMSampleBuffer, with type: RPSampleBufferType) {
    guard type == .video, let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
    // The buffer is always the portrait screen; this says how it is turned.
    let raw = (CMGetAttachment(sample, key: RPVideoSampleOrientationKey as CFString,
                               attachmentModeOut: nil) as? NSNumber)?.uint32Value
    let orientation = raw.flatMap(CGImagePropertyOrientation.init(rawValue:)) ?? .up
    lock.lock()
    last = (pixels, orientation)
    dirty = true
    let schedule = !pumpQueued
    pumpQueued = true
    lock.unlock()
    if schedule {
      queue.async {
        self.lock.lock(); self.pumpQueued = false; self.lock.unlock()
        self.pump()
      }
    }
  }

  private func stop(_ message: String) {
    finishBroadcastWithError(NSError(domain: "Calenduel", code: 1,
                                     userInfo: [NSLocalizedDescriptionKey: message]))
  }

  // MARK: Connection (on `queue`)

  private func findMac() {
    guard !finished, conn == nil, finder == nil else { return }
    let finder = MacFinder(code: code, queue: queue) { [weak self] outcome in self?.found(outcome) }
    self.finder = finder
    finder.start(timeout: 15)
  }

  private func found(_ outcome: MacFinder.Outcome) {
    finder = nil
    switch outcome {
    case .connected(let c, _):
      if finished { return c.cancel() }
      attach(c)
    case .wrongCode:
      stop("This iPad's pairing code doesn't match your Mac's. Open Calenduel Link and pair again.")
    case .notFound, .noAnswer:
      // The Mac may be asleep or the helper not running yet: keep looking.
      queue.asyncAfter(deadline: .now() + 3) { self.findMac() }
    }
  }

  private func attach(_ c: NWConnection) {
    conn = c
    wanted = false // the Mac says WANT right away if a session is running
    sending = false
    c.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: self?.detach(c)
      default: break
      }
    }
    receive(c)
  }

  private func detach(_ c: NWConnection) {
    guard conn === c else { return }
    c.cancel()
    conn = nil
    wanted = false
    queue.asyncAfter(deadline: .now() + 2) { self.findMac() }
  }

  private func receive(_ c: NWConnection) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 64) { [weak self] data, _, done, error in
      guard let self, self.conn === c else { return }
      for byte in data ?? Data() {
        if byte == Link.want {
          self.wanted = true
          // Send the current screen even if it hasn't changed: a still iPad sends
          // no new frames, and the Mac dropped its old one when it went idle.
          self.lock.lock(); self.dirty = self.last != nil; self.lock.unlock()
        } else if byte == Link.idle {
          self.wanted = false
        }
      }
      if done || error != nil { return self.detach(c) }
      self.pump()
      self.receive(c)
    }
  }

  // MARK: Frames (on `queue`)

  // Sends the newest screen if the Mac wants it, at most MAX_FPS, one at a time.
  // A screen update during the wait is never lost: the last one is flushed after.
  private func pump() {
    guard wanted, !sending, let conn, conn.state == .ready else { return }
    lock.lock()
    guard dirty, let frame = last else { lock.unlock(); return }
    lock.unlock()
    let wait = lastEncode + 1 / MAX_FPS - CFAbsoluteTimeGetCurrent()
    if wait > 0 {
      if !flushQueued {
        flushQueued = true
        queue.asyncAfter(deadline: .now() + wait) {
          self.flushQueued = false
          self.pump()
        }
      }
      return
    }
    lock.lock(); dirty = false; lock.unlock()
    lastEncode = CFAbsoluteTimeGetCurrent()
    guard let jpeg = autoreleasepool(invoking: { encode(frame.pixels, frame.orientation) }) else { return }
    sending = true
    conn.send(content: Link.frameMessage(jpeg), completion: .contentProcessed { [weak self] _ in
      guard let self else { return }
      self.sending = false
      self.pump()
    })
  }

  private func encode(_ pixels: CVPixelBuffer, _ orientation: CGImagePropertyOrientation) -> Data? {
    var image = CIImage(cvPixelBuffer: pixels).oriented(orientation)
    image = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
    let scale = min(1, MAX_SIDE / max(image.extent.width, image.extent.height))
    if scale < 1 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
    guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    return ci.jpegRepresentation(of: image, colorSpace: space, options: [
      CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.7,
    ])
  }
}
