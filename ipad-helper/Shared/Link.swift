// The Wi-Fi link between the iPad app's broadcast extension and the Mac helper.
// Compiled into both: the Mac helper (build.sh) and the iPad app (ios/).
//
// The Mac advertises a Bonjour service; the iPad connects to it over TLS keyed by
// a pre-shared key derived from the pairing code shown in the Mac's menu. Only an
// iPad with the same code completes the handshake, and the frames are encrypted.
//
// Wire format, both directions inside TLS:
//   iPad → Mac: [4-byte big-endian length][JPEG], one message per frame.
//   Mac → iPad: single bytes. WANT: a page is asking for frames, send them.
//               IDLE: nobody is asking, stop encoding (saves the iPad's battery).
import CryptoKit
import Foundation
import Network
import Security

enum Link {
  static let serviceType = "_calenduel-ipad._tcp"
  static let want: UInt8 = 0x57 // "W"
  static let idle: UInt8 = 0x49 // "I"
  static let maxMessage = 8 << 20

  private static let identity = "calenduel-ipad"
  // 32 symbols with no look-alikes (no 0/O, 1/I): 12 of them are 60 bits.
  private static let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")

  static func newCode() -> String {
    var chars: [Character] = []
    for _ in 0..<12 { chars.append(alphabet[Int.random(in: 0..<alphabet.count)]) }
    return group(chars)
  }

  // "abcd efgh-jklm" → "ABCD-EFGH-JKLM", or nil if it isn't a code.
  static func normalize(_ text: String) -> String? {
    let chars = text.uppercased().filter { $0.isLetter || $0.isNumber }
    guard chars.count == 12, chars.allSatisfy(alphabet.contains) else { return nil }
    return group(Array(chars))
  }

  private static func group(_ chars: [Character]) -> String {
    stride(from: 0, to: chars.count, by: 4).map { String(chars[$0..<$0 + 4]) }.joined(separator: "-")
  }

  // TCP + TLS 1.2 with a pre-shared key. Same parameters on both ends.
  static func parameters(code: String) -> NWParameters {
    let tls = NWProtocolTLS.Options()
    let key = SymmetricKey(data: Data(code.utf8))
    let psk = Data(HMAC<SHA256>.authenticationCode(for: Data(identity.utf8), using: key))
    let options = tls.securityProtocolOptions
    sec_protocol_options_add_pre_shared_key(options, dispatchData(psk), dispatchData(Data(identity.utf8)))
    sec_protocol_options_append_tls_ciphersuite(
      options, tls_ciphersuite_t(rawValue: UInt16(TLS_PSK_WITH_AES_128_GCM_SHA256))!)
    sec_protocol_options_set_min_tls_protocol_version(options, .TLSv12)
    sec_protocol_options_set_max_tls_protocol_version(options, .TLSv12)
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.enableKeepalive = true // notice a Mac or iPad that vanished from Wi-Fi
    tcp.keepaliveIdle = 5
    tcp.keepaliveInterval = 2
    tcp.keepaliveCount = 3
    return NWParameters(tls: tls, tcp: tcp)
  }

  private static func dispatchData(_ data: Data) -> __DispatchData {
    data.withUnsafeBytes { DispatchData(bytes: $0) } as __DispatchData
  }

  static func frameMessage(_ jpeg: Data) -> Data {
    let n = UInt32(jpeg.count)
    var out = Data([UInt8(n >> 24), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)])
    out.append(jpeg)
    return out
  }

  // Reads one length-prefixed message; nil when the connection ends or misbehaves.
  static func readMessage(_ conn: NWConnection, _ done: @escaping (Data?) -> Void) {
    conn.receive(minimumIncompleteLength: 4, maximumLength: 4) { head, _, _, error in
      guard let head, head.count == 4, error == nil else { return done(nil) }
      let n = head.reduce(0) { $0 << 8 | Int($1) }
      guard n > 0, n <= maxMessage else { return done(nil) }
      conn.receive(minimumIncompleteLength: n, maximumLength: n) { body, _, _, error in
        guard let body, body.count == n, error == nil else { return done(nil) }
        done(body)
      }
    }
  }
}
