// Calenduel Link: pairs this iPad with the Calenduel iPad helper on your Mac and
// starts the screen broadcast that sends the iPad to your session over Wi-Fi.
// The sending itself happens in the broadcast extension (Broadcast/).
import ReplayKit
import SwiftUI

@main
struct CalenduelLinkApp: App {
  var body: some Scene {
    WindowGroup { ContentView() }
  }
}

struct ContentView: View {
  @State private var codeText = PairingStore.code ?? ""
  @State private var status = PairingStore.code == nil ? "Not paired yet." : "Paired. Tap Pair to check the connection."
  @State private var checking = false
  @State private var finder: MacFinder?
  // Kept in @State so taps reach the same picker that's on screen.
  @State private var picker = BroadcastPicker()

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text("On your Mac, click the Calenduel iPad icon in the menu bar and type the **Wi-Fi pairing code** shown there.")
          TextField("ABCD-EFGH-JKLM", text: $codeText)
            .font(.system(.title3, design: .monospaced))
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .onSubmit(pair)
          Button(checking ? "Looking for your Mac…" : "Pair", action: pair)
            .disabled(checking)
          Text(status).foregroundStyle(.secondary)
        } header: {
          Text("1 · Pair with your Mac")
        }

        Section {
          Button("Start Sharing iPad Screen") { picker.tap() }
          Text("Then start a Calenduel session on your Mac: the iPad shows up within a few seconds. You can also start it from Control Center: long-press Screen Recording and choose Calenduel. Stop it from the red pill at the top of the screen.")
            .font(.footnote)
            .foregroundStyle(.secondary)
          picker.frame(width: 1, height: 1).opacity(0.01)
        } header: {
          Text("2 · Share your screen")
        } footer: {
          Text("Only your Mac with this code can receive the screen, encrypted. The iPad only encodes frames while a session is running.")
        }
      }
      .navigationTitle("Calenduel Link")
    }
    .navigationViewStyle(.stack)
  }

  private func pair() {
    guard let code = Link.normalize(codeText) else {
      status = "That isn't a pairing code. It's 12 letters and digits, like ABCD-EFGH-JKLM."
      return
    }
    codeText = code
    PairingStore.code = code
    checking = true
    status = "Looking for your Mac on this Wi-Fi…"
    let finder = MacFinder(code: code, queue: .main) { outcome in
      checking = false
      self.finder = nil
      switch outcome {
      case .connected(let conn, let mac):
        conn.cancel()
        status = "Paired with \(mac). Now start sharing below."
      case .wrongCode, .noAnswer:
        status = "Found your Mac, but it didn't accept this code. Check it against the code in the Calenduel iPad menu on your Mac."
      case .notFound:
        status = "Couldn't find your Mac. Is the Calenduel iPad helper running, on the same Wi-Fi? If iPadOS asked about Local Network access, allow it (Settings → Calenduel Link)."
      }
    }
    self.finder = finder
    finder.start(timeout: 10)
  }
}

// The system broadcast picker, preset to our extension. Its own button is a bare
// icon, so it's hidden and a regular button taps it.
struct BroadcastPicker: UIViewRepresentable {
  let view: RPSystemBroadcastPickerView = {
    let view = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
    view.preferredExtension = "com.calenduel.ipadlink.broadcast"
    view.showsMicrophoneButton = false
    return view
  }()

  func makeUIView(context: Context) -> RPSystemBroadcastPickerView { view }
  func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}

  func tap() {
    for case let button as UIButton in view.subviews { button.sendActions(for: .allTouchEvents) }
  }
}
