// Calenduel iPad: a menu-bar helper that gets the iPad's screen two ways and
// hands the latest frame to the Calenduel page over http://127.0.0.1:
// - USB: reads a plugged-in iPad the same way QuickTime's "New Movie Recording →
//   iPad" does.
// - Wi-Fi: receives frames from the Calenduel Link iPad app's screen broadcast
//   (ios/), paired with the code in this app's menu. See Shared/Link.swift.
// No QuickTime window and no screen-share picker: the page fetches frames while a
// session is running.
//
// Privacy: the page server listens on the loopback interface only and answers only
// the Origins below. The Wi-Fi listener only accepts an iPad holding the pairing
// code, over TLS. Frames are captured (USB) or encoded on the iPad (Wi-Fi) only
// while a page is asking for them, and nothing is kept on disk. The menu-bar icon
// turns red while frames are flowing.
//
// Build and install: ./build.sh --install (see README.md).
import AppKit
import AVFoundation
import CoreImage
import CoreMediaIO
import Network
import ServiceManagement

let PORT: UInt16 = 47615
#if DEV // ./build.sh --dev: also answer the local vite dev server
let ALLOWED_ORIGINS: Set<String> = [
  "https://calenduel.com", "https://www.calenduel.com",
  "http://localhost:5173", "http://127.0.0.1:5173",
]
#else
let ALLOWED_ORIGINS: Set<String> = ["https://calenduel.com", "https://www.calenduel.com"]
#endif
let MAX_SIDE: CGFloat = 1600 // long side of served frames; the timelapse pane is smaller
let MAX_FPS = 4.0 // frames encoded per second at most; the page polls ~2/s
let IDLE_STOP = 10.0 // seconds without a frame request before capture stops
let SITE = URL(string: "https://calenduel.com/?ipadHelper=1")!

// MARK: - Capture

final class IPadCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  struct Frame { let jpeg: Data; let at: Date }

  // Guards latest, lastRequest and the two published flags.
  private let lock = NSLock()
  private var latest: Frame?
  private var lastRequest = Date.distantPast
  private var isConnected = false
  private var isCapturing = false
  // Touched on `frames` only.
  private var lastEncode: CFAbsoluteTime = 0
  private var held: CVPixelBuffer?
  private var flushQueued = false
  private let ci = CIContext()
  private let frames = DispatchQueue(label: "calenduel.ipad.frames")
  private let control = DispatchQueue(label: "calenduel.ipad.control")

  // Touched on `control` only.
  private var device: AVCaptureDevice?
  private var session: AVCaptureSession?

  var onChange: (() -> Void)?

  override init() {
    super.init()
    // iPad screens are hidden from AVFoundation until a process opts in. This is
    // per process, which is why Chrome can't see the iPad on its own.
    var prop = CMIOObjectPropertyAddress(
      mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
      mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
      mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var allow: UInt32 = 1
    CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil,
                              UInt32(MemoryLayout<UInt32>.size), &allow)
    // The device appears asynchronously, delivered on the main run loop. A
    // blocking wait on the main thread never sees it.
    for name in [AVCaptureDevice.wasConnectedNotification, AVCaptureDevice.wasDisconnectedNotification] {
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
        self?.control.async { self?.refreshDevice() }
      }
    }
    control.async { self.refreshDevice() }
  }

  private func findIPad() -> AVCaptureDevice? {
    let found = AVCaptureDevice.DiscoverySession(
      deviceTypes: [.external], mediaType: .muxed, position: .unspecified).devices
    return found.first { $0.modelID == "iOS Device" && $0.localizedName.lowercased().contains("pad") }
  }

  private func refreshDevice() {
    let now = findIPad()
    if now?.uniqueID == device?.uniqueID { return }
    stopSession()
    device = now
    lock.lock(); isConnected = now != nil; lock.unlock()
    onChange?()
  }

  // Called by the server for every frame request: keep (or start) capturing.
  func want() {
    lock.lock(); lastRequest = Date(); lock.unlock()
    control.async { if self.session == nil, self.device != nil { self.startSession() } }
  }

  // Runs every couple of seconds: stop when no page has asked for a while, and
  // pick up an iPad that was plugged in without a notification.
  func tick() {
    control.async {
      self.lock.lock(); let idle = Date().timeIntervalSince(self.lastRequest); self.lock.unlock()
      if self.session != nil, idle > IDLE_STOP { self.stopSession(); self.onChange?() }
      if self.session == nil { self.refreshDevice() }
    }
  }

  private func startSession() {
    guard let device else { return }
    let s = AVCaptureSession()
    guard let input = try? AVCaptureDeviceInput(device: device), s.canAddInput(input) else { return }
    s.addInput(input)
    let output = AVCaptureVideoDataOutput()
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    output.alwaysDiscardsLateVideoFrames = true
    output.setSampleBufferDelegate(self, queue: frames)
    guard s.canAddOutput(output) else { return }
    s.addOutput(output)
    s.startRunning() // blocks; that is why it runs on `control`
    session = s
    lock.lock(); isCapturing = true; lock.unlock()
    onChange?()
  }

  private func stopSession() {
    guard let s = session else { return }
    s.stopRunning()
    session = nil
    // Let any frame already being encoded finish first, then clear: a frame
    // left over from an earlier session must never be served as current.
    frames.sync { held = nil }
    lock.lock(); latest = nil; isCapturing = false; lock.unlock()
  }

  // At most MAX_FPS encodes, but never drop the LAST frame of a burst: the iPad
  // sends nothing more once its screen settles (after a page turn, or when it
  // locks), so a dropped final frame would leave a stale picture being served.
  func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer,
                     from connection: AVCaptureConnection) {
    guard let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
    held = pixels
    let wait = lastEncode + 1 / MAX_FPS - CFAbsoluteTimeGetCurrent()
    if wait <= 0 { encodeHeld(); return }
    if !flushQueued {
      flushQueued = true
      frames.asyncAfter(deadline: .now() + wait) { [weak self] in
        self?.flushQueued = false
        self?.encodeHeld()
      }
    }
  }

  private func encodeHeld() {
    guard let pixels = held else { return }
    held = nil
    lastEncode = CFAbsoluteTimeGetCurrent()
    var image = CIImage(cvPixelBuffer: pixels)
    let scale = min(1, MAX_SIDE / max(image.extent.width, image.extent.height))
    if scale < 1 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let jpeg = ci.jpegRepresentation(of: image, colorSpace: space,
            options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.75])
    else { return }
    let frame = Frame(jpeg: jpeg, at: Date())
    lock.lock(); latest = frame; lock.unlock()
  }

  // The newest frame. The iPad only sends frames when its screen changes, so a
  // still page keeps the last one: that is still what the iPad shows.
  var frame: Frame? { lock.lock(); defer { lock.unlock() }; return latest }
  // Never wait on `control`: starting or stopping capture blocks it for seconds.
  var connected: Bool { lock.lock(); defer { lock.unlock() }; return isConnected }
  var capturing: Bool { lock.lock(); defer { lock.unlock() }; return isCapturing }
}

// MARK: - Wi-Fi link

// Receives frames from the iPad app's broadcast extension. One iPad at a time:
// a newly connected one replaces the old. Tells the iPad whether anyone wants
// frames, so it only encodes during a session.
final class WirelessLink {
  private let queue = DispatchQueue(label: "calenduel.ipad.wifi")

  // Guards the fields below it.
  private let lock = NSLock()
  private var latest: IPadCapture.Frame?
  private var isConnected = false
  private var isWanting = false
  private var lastRequest = Date.distantPast

  // Touched on `queue` only.
  private var listener: NWListener?
  private var conn: NWConnection?

  // Main thread only.
  private(set) var code: String

  var onChange: (() -> Void)?

  init() {
    if let saved = UserDefaults.standard.string(forKey: "pairCode"), let code = Link.normalize(saved) {
      self.code = code
    } else {
      code = Link.newCode()
      UserDefaults.standard.set(code, forKey: "pairCode")
    }
  }

  func start() {
    let code = self.code
    queue.async { self.listen(code: code) }
  }

  // A new code unpairs every iPad: the old one can no longer connect.
  func resetCode() {
    code = Link.newCode()
    UserDefaults.standard.set(code, forKey: "pairCode")
    let code = self.code
    queue.async {
      self.listener?.cancel()
      self.listener = nil
      self.conn?.cancel()
      self.listen(code: code)
    }
  }

  private func listen(code: String) {
    let listener: NWListener
    do { listener = try NWListener(using: Link.parameters(code: code)) } catch {
      NSLog("Calenduel iPad: cannot start the Wi-Fi listener: \(error)")
      return
    }
    listener.service = NWListener.Service(type: Link.serviceType) // named after this Mac
    listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
    listener.stateUpdateHandler = { [weak self, weak listener] state in
      guard let self, let listener, case .failed(let error) = state else { return }
      NSLog("Calenduel iPad: Wi-Fi listener failed: \(error); retrying")
      listener.cancel()
      self.queue.asyncAfter(deadline: .now() + 5) {
        if self.listener === listener { self.listen(code: code) }
      }
    }
    listener.start(queue: queue)
    self.listener = listener
  }

  private func accept(_ new: NWConnection) {
    new.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        // Handshake done, so it holds the code. Only now replace the old one: a
        // stranger without the code can't knock a working iPad off.
        let old = self.conn
        self.conn = new
        old?.cancel()
        self.lock.lock(); self.isConnected = true; self.latest = nil; self.lock.unlock()
        self.onChange?()
        self.sendWantState()
        self.readFrames(new)
      case .failed, .waiting:
        new.cancel() // also how a wrong code ends: close it so the iPad hears at once
      case .cancelled:
        self.lost(new)
      default:
        break
      }
    }
    new.start(queue: queue)
    // A wrong code fails the handshake at once; anything still not ready is dropped.
    queue.asyncAfter(deadline: .now() + 10) { [weak new] in
      if let new, new.state != .ready { new.cancel() }
    }
  }

  private func lost(_ old: NWConnection) {
    guard conn === old else { return }
    conn = nil
    lock.lock(); isConnected = false; latest = nil; lock.unlock()
    onChange?()
  }

  private func readFrames(_ c: NWConnection) {
    Link.readMessage(c) { [weak self] message in
      guard let self, self.conn === c else { return }
      guard let jpeg = message else { return c.cancel() }
      self.lock.lock()
      // Frames still in flight after IDLE are dropped: nobody asked for them.
      if self.isWanting { self.latest = IPadCapture.Frame(jpeg: jpeg, at: Date()) }
      self.lock.unlock()
      self.readFrames(c)
    }
  }

  // Runs on `queue`.
  private func sendWantState() {
    lock.lock(); let wanting = isWanting; lock.unlock()
    conn?.send(content: Data([wanting ? Link.want : Link.idle]), completion: .idempotent)
  }

  // Called by the server for every frame request.
  func want() {
    lock.lock()
    lastRequest = Date()
    let changed = !isWanting
    isWanting = true
    lock.unlock()
    if changed {
      queue.async { self.sendWantState() }
      onChange?()
    }
  }

  // Runs every couple of seconds: tell the iPad to stop once no page has asked
  // for a while, and forget the last frame so a later session never sees it.
  func tick() {
    lock.lock()
    let stop = isWanting && Date().timeIntervalSince(lastRequest) > IDLE_STOP
    if stop { isWanting = false; latest = nil }
    lock.unlock()
    if stop {
      queue.async { self.sendWantState() }
      onChange?()
    }
  }

  var frame: IPadCapture.Frame? { lock.lock(); defer { lock.unlock() }; return latest }
  var connected: Bool { lock.lock(); defer { lock.unlock() }; return isConnected }
  var sending: Bool { lock.lock(); defer { lock.unlock() }; return isConnected && isWanting }
}

// MARK: - Loopback HTTP server

final class Server {
  private let capture: IPadCapture
  private let wireless: WirelessLink
  private var listener: NWListener?
  private let queue = DispatchQueue(label: "calenduel.ipad.server")

  init(capture: IPadCapture, wireless: WirelessLink) {
    self.capture = capture
    self.wireless = wireless
  }

  // Whichever source sent the newest picture: an iPad on both USB and Wi-Fi
  // shows the same screen anyway.
  private var newestFrame: IPadCapture.Frame? {
    switch (capture.frame, wireless.frame) {
    case let (usb?, wifi?): return usb.at > wifi.at ? usb : wifi
    case let (usb, wifi): return usb ?? wifi
    }
  }

  private var connected: Bool { capture.connected || wireless.connected }

  func start() throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: PORT)!)
    params.allowLocalEndpointReuse = true
    let listener = try NWListener(using: params)
    listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
    listener.stateUpdateHandler = { state in
      if case .failed(let error) = state {
        NSLog("Calenduel iPad: cannot listen on 127.0.0.1:\(PORT): \(error)")
        DispatchQueue.main.async { NSApp.terminate(nil) } // likely already running
      }
    }
    listener.start(queue: queue)
    self.listener = listener
  }

  private func accept(_ conn: NWConnection) {
    conn.start(queue: queue)
    // A client that never finishes its request headers gets dropped.
    queue.asyncAfter(deadline: .now() + 5) { if conn.state != .cancelled { conn.cancel() } }
    read(conn, buffer: Data())
  }

  private func read(_ conn: NWConnection, buffer: Data) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, done, error in
      guard let self else { return }
      var buffer = buffer
      if let data { buffer.append(data) }
      if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
        self.respond(conn, head: String(decoding: buffer[..<end.lowerBound], as: UTF8.self))
      } else if done || error != nil || buffer.count > 16_384 {
        conn.cancel()
      } else {
        self.read(conn, buffer: buffer)
      }
    }
  }

  private func respond(_ conn: NWConnection, head: String) {
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ") ?? []
    let method = parts.count > 0 ? String(parts[0]) : ""
    let path = parts.count > 1 ? String(parts[1].split(separator: "?").first ?? "") : ""
    var origin: String?
    for line in lines.dropFirst() {
      if let colon = line.firstIndex(of: ":"),
         line[..<colon].trimmingCharacters(in: .whitespaces).lowercased() == "origin" {
        origin = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      }
    }
    // Browsers always send Origin on a cross-origin fetch. Anything else (another
    // site, an <img> tag, a request with no Origin) gets nothing.
    guard let origin, ALLOWED_ORIGINS.contains(origin) else {
      return send(conn, status: "403 Forbidden", headers: [:], body: Data())
    }
    var cors = [
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Cache-Control": "no-store",
    ]
    switch (method, path) {
    case ("OPTIONS", _):
      cors["Access-Control-Allow-Methods"] = "GET"
      cors["Access-Control-Allow-Private-Network"] = "true"
      cors["Access-Control-Max-Age"] = "600"
      send(conn, status: "204 No Content", headers: cors, body: Data())
    case ("GET", "/status"):
      let body: [String: Any] = [
        "app": "calenduel-ipad", "version": 1,
        "connected": connected, "capturing": capture.capturing || wireless.sending,
        "usb": capture.connected, "wifi": wireless.connected,
      ]
      cors["Content-Type"] = "application/json"
      send(conn, status: "200 OK", headers: cors,
           body: (try? JSONSerialization.data(withJSONObject: body)) ?? Data())
    case ("GET", "/frame"):
      capture.want()
      wireless.want()
      if let frame = newestFrame {
        cors["Content-Type"] = "image/jpeg"
        send(conn, status: "200 OK", headers: cors, body: frame.jpeg)
      } else {
        // 204: connected but no picture yet (a still iPad sends nothing until
        // its screen changes). 404: no iPad at all.
        send(conn, status: connected ? "204 No Content" : "404 Not Found", headers: cors, body: Data())
      }
    default:
      send(conn, status: "404 Not Found", headers: cors, body: Data())
    }
  }

  private func send(_ conn: NWConnection, status: String, headers: [String: String], body: Data) {
    var head = "HTTP/1.1 \(status)\r\nConnection: close\r\nContent-Length: \(body.count)\r\n"
    for (k, v) in headers { head += "\(k): \(v)\r\n" }
    var out = Data((head + "\r\n").utf8)
    out.append(body)
    conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
  }
}

// MARK: - Menu bar

final class App: NSObject, NSApplicationDelegate {
  let capture = IPadCapture()
  let wireless = WirelessLink()
  lazy var server = Server(capture: capture, wireless: wireless)
  var item: NSStatusItem!
  let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  let codeLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  let loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")

  func applicationDidFinishLaunching(_ note: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let menu = NSMenu()
    statusLine.isEnabled = false
    menu.addItem(statusLine)
    menu.addItem(.separator())
    codeLine.isEnabled = false
    menu.addItem(codeLine)
    let copyCode = NSMenuItem(title: "Copy Pairing Code", action: #selector(copyCode), keyEquivalent: "")
    copyCode.target = self
    menu.addItem(copyCode)
    let newCode = NSMenuItem(title: "New Pairing Code…", action: #selector(resetCode), keyEquivalent: "")
    newCode.target = self
    menu.addItem(newCode)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Open Calenduel", action: #selector(openSite), keyEquivalent: ""))
    loginItem.target = self
    menu.addItem(loginItem)
    menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    for entry in menu.items where entry.action == #selector(openSite) { entry.target = self }
    item.menu = menu

    capture.onChange = { [weak self] in DispatchQueue.main.async { self?.render() } }
    wireless.onChange = { [weak self] in DispatchQueue.main.async { self?.render() } }
    do { try server.start() } catch { NSLog("Calenduel iPad: \(error)"); NSApp.terminate(nil) }
    wireless.start()
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      self?.capture.tick()
      self?.wireless.tick()
      self?.render()
    }

    // First launch: start at login, and tell the Calenduel page (in the default
    // browser) that this helper exists, so it starts asking for frames.
    if !UserDefaults.standard.bool(forKey: "launchedBefore") {
      UserDefaults.standard.set(true, forKey: "launchedBefore")
      try? SMAppService.mainApp.register()
      openSite()
    }
    render()
  }

  func render() {
    let usb = capture.connected
    let wifi = wireless.connected
    let connected = usb || wifi
    let capturing = capture.capturing || wireless.sending
    let image = NSImage(systemSymbolName: "ipad", accessibilityDescription: "Calenduel iPad")
    image?.isTemplate = !capturing
    item.button?.image = image
    item.button?.contentTintColor = capturing ? .systemRed : nil
    item.button?.appearsDisabled = !connected
    let via = usb && wifi ? "USB and Wi-Fi" : usb ? "USB" : "Wi-Fi"
    statusLine.title = capturing ? "Sending iPad screen to Calenduel (\(via))"
      : connected ? "iPad connected over \(via) · waiting for a session"
      : "No iPad · broadcast from Calenduel Link, or plug in by USB"
    codeLine.title = "Wi-Fi pairing code: \(wireless.code)"
    loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
  }

  @objc func openSite() { NSWorkspace.shared.open(SITE) }

  @objc func copyCode() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(wireless.code, forType: .string)
  }

  @objc func resetCode() {
    let alert = NSAlert()
    alert.messageText = "Make a new pairing code?"
    alert.informativeText = "The paired iPad disconnects and has to be paired again with the new code in the Calenduel Link app."
    alert.addButton(withTitle: "New Code")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    wireless.resetCode()
    render()
  }

  @objc func toggleLogin() {
    if SMAppService.mainApp.status == .enabled { try? SMAppService.mainApp.unregister() }
    else { try? SMAppService.mainApp.register() }
    render()
  }
}

@main
enum Main {
  static let delegate = App()
  static func main() {
    let app = NSApplication.shared
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
  }
}
