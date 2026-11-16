import Foundation
import Network

// The pairing code, shared between the app (which saves it) and the broadcast
// extension (which reads it) through their app group.
enum PairingStore {
  static let group = "group.com.calenduel.ipadlink"
  private static let key = "pairCode"

  static var code: String? {
    get { UserDefaults(suiteName: group)?.string(forKey: key) }
    set { UserDefaults(suiteName: group)?.set(newValue, forKey: key) }
  }
}

// Finds the paired Mac on the local network: browses for the helper's Bonjour
// service and opens a TLS connection keyed by the pairing code to each Mac it
// sees. Only a helper with the same code completes the handshake; the first one
// that does wins. Reports once, then stops.
final class MacFinder {
  enum Outcome {
    case connected(NWConnection, macName: String)
    case wrongCode // a helper refused the handshake: the codes don't match
    // Found a helper but no handshake finished. Almost always a code mismatch too
    // (a refused PSK handshake tends to leave the iPad side retrying, not failing),
    // but could be a Mac that's asleep or behind a firewall.
    case noAnswer
    case notFound
  }

  private let code: String
  private let queue: DispatchQueue
  private let done: (Outcome) -> Void

  // Touched on `queue` only.
  private var browser: NWBrowser?
  private var attempts: [NWEndpoint: NWConnection] = [:]
  private var tried = Set<NWEndpoint>()
  private var sawWrongCode = false
  private var finished = false

  init(code: String, queue: DispatchQueue, done: @escaping (Outcome) -> Void) {
    self.code = code
    self.queue = queue
    self.done = done
  }

  func start(timeout: TimeInterval) {
    queue.async {
      let browser = NWBrowser(for: .bonjour(type: Link.serviceType, domain: nil), using: NWParameters())
      browser.browseResultsChangedHandler = { [weak self] results, _ in self?.update(results) }
      browser.stateUpdateHandler = { [weak self] state in
        if case .failed = state { self?.finish(.notFound) }
      }
      browser.start(queue: self.queue)
      self.browser = browser
      self.queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
        guard let self else { return }
        self.finish(self.sawWrongCode ? .wrongCode : self.tried.isEmpty ? .notFound : .noAnswer)
      }
    }
  }

  func cancel() { queue.async { self.finish(nil) } }

  private func update(_ results: Set<NWBrowser.Result>) {
    let now = Set(results.map(\.endpoint))
    tried.formIntersection(now) // a helper that went away and came back gets retried
    for endpoint in now where !tried.contains(endpoint) {
      tried.insert(endpoint)
      attempt(endpoint)
    }
  }

  private func attempt(_ endpoint: NWEndpoint) {
    let conn = NWConnection(to: endpoint, using: Link.parameters(code: code))
    attempts[endpoint] = conn
    conn.stateUpdateHandler = { [weak self, weak conn] state in
      guard let self, let conn, !self.finished else { return }
      switch state {
      case .ready:
        self.attempts[endpoint] = nil
        conn.stateUpdateHandler = nil
        var name = "your Mac"
        if case .service(let service, _, _, _) = endpoint { name = service }
        self.finish(.connected(conn, macName: name))
      case .failed(let error), .waiting(let error):
        if case .tls = error { self.sawWrongCode = true }
        self.attempts[endpoint] = nil
        conn.cancel()
      default:
        break
      }
    }
    conn.start(queue: queue)
  }

  private func finish(_ outcome: Outcome?) {
    guard !finished else {
      if case .connected(let conn, _)? = outcome { conn.cancel() }
      return
    }
    finished = true
    browser?.cancel()
    browser = nil
    for conn in attempts.values { conn.cancel() }
    attempts = [:]
    if let outcome { done(outcome) }
  }
}
