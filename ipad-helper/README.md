# Calenduel iPad

A small menu-bar app for macOS 13+ that puts your iPad in the session timelapse
with no setup per session. It gets the iPad's screen either way:

- **Wi-Fi**: the *Calenduel Link* iPad app (`ios/`) broadcasts the screen to it.
  No cable, so your laptop doesn't charge the iPad.
- **USB**: plug the iPad in. It reads the screen the way QuickTime's *New Movie
  Recording → iPad* does (CoreMediaIO screen-capture devices).

Either way it serves the newest frame on `http://127.0.0.1:47615`. Chrome can't
open the iPad itself: macOS only shows iPad screens to a process that asks for
them.

## Install

Needs the Xcode command-line tools (`xcode-select --install`).

```sh
./ipad-helper/build.sh --install
```

This builds `Calenduel iPad.app` (ad-hoc signed, for your own Mac), copies it to
`~/Applications` and opens it. On first launch it:

1. adds itself as a login item (toggle it in the menu), and
2. opens `calenduel.com/?ipadHelper=1`, which turns the helper on for that browser.

macOS may ask for camera access the first time it reads the iPad, and Chrome asks
once whether calenduel.com may access apps on this device. Allow both.

## Wi-Fi: install Calenduel Link on the iPad (once)

Needs full Xcode, signed in to your Apple ID (Xcode → Settings → Accounts).

1. Open `ipad-helper/ios/CalenduelLink.xcodeproj`. (It's generated from
   `project.yml`; after changing that, run `xcodegen` in `ios/`.)
2. If Xcode complains about the team, pick yours under *Signing & Capabilities*
   for both targets (CalenduelLink and Broadcast). Same for a bundle ID that's
   taken: change `com.calenduel.ipadlink` in `project.yml`, `PairingStore.group`
   and `BroadcastPicker`.
3. Connect the iPad by USB this one time, pick it as the run destination and
   press Run. The first time, allow the developer on the iPad: Settings →
   General → VPN & Device Management.
   With a free Apple ID the app stops opening after 7 days. Press Run again to
   renew it (it works over Wi-Fi once *Connect via network* is ticked for the
   iPad in Window → Devices and Simulators).
4. In the app, type the **Wi-Fi pairing code** from the helper's menu and tap
   **Pair**. Allow Local Network access when asked.

## Use

**Wi-Fi:** on the iPad, tap **Start Sharing iPad Screen** in Calenduel Link (or
Control Center → long-press Screen Recording → *Calenduel* → Start Broadcast).
Then start a session on the Mac: the iPad shows up under your face within a few
seconds. Stop the broadcast from the red pill at the top of the iPad. The iPad
only encodes frames while a session is asking for them.

**USB:** unlock the iPad, connect it by USB and tap **Trust** the first time.
Start a session: the iPad shows up under your face within a few seconds.

Either way: **Remove iPad**
takes it out for the rest of the session; **Add iPad** brings it back. Without
the helper, **Add iPad** still offers the window picker (QuickTime mirroring).

The menu-bar icon is grey with no iPad, normal when one is connected, and red
while it is sending frames to a session. The menu says whether it's over USB or
Wi-Fi.

## Privacy

- Listens on 127.0.0.1 only and answers only calenduel.com (and the local dev
  server). Other sites, `<img>` tags and requests without an Origin get 403.
- The Wi-Fi link only accepts an iPad holding the pairing code. Frames travel
  over TLS keyed by it (`Shared/Link.swift`). **New Pairing Code…** in the menu
  unpairs every iPad.
- Captures (USB) or has the iPad encode (Wi-Fi) only while a page is asking for
  frames; stops after 10 s without one.
- Keeps nothing on disk. Frames stay in memory until the next one replaces them.
- To turn it off in a browser, open `calenduel.com/?ipadHelper=0`.

## Endpoints

- `GET /status`: `{"app":"calenduel-ipad","version":1,"connected":bool,"capturing":bool,"usb":bool,"wifi":bool}`
- `GET /frame`: newest frame as JPEG (long side at most 1600 px). 204 while
  connected with no picture yet, 404 with no iPad.
