# Xbox Input Bridge

Xbox Input Bridge maps keyboard and mouse input to a virtual standard gamepad
inside Xbox Cloud Gaming in Chrome and Microsoft Edge.

The project is under active development. The current controller backend is a
safe in-memory implementation for development and tests. A production driver
will only be enabled after its signing, maintenance, licensing, security, and
compatibility have been reviewed.

The browser extension is driverless and does not require the Windows companion.
It affects only matched Xbox Cloud Gaming pages; it does not expose a controller
to Windows or installed games. The companion remains a development foundation
for a later reviewed production backend.

## Use in Chrome or Edge

1. Run `npm install` and `npm run build`.
2. Open `chrome://extensions` or `edge://extensions`, enable Developer mode,
   choose **Load unpacked**, and select `apps\extension\dist`.
3. Open `https://www.xbox.com/play`, choose a game, select the extension, and
   press **Start capture**.
4. Confirm the in-page activation prompt. Press `Esc` to release pointer lock
   and stop capture.

In fullscreen game containers, an activation prompt appears above the game;
click it to start without opening the extension popup. You can also press
**Ctrl+Alt+G** on the Xbox play page to start or stop capture, including native
video fullscreen and browser fullscreen (F11), where the prompt may not appear.
The shortcut starts only from your keypress; entering fullscreen alone never
captures input. Press **Ctrl+Alt+G** again to stop without using Esc.

Press **Ctrl+Alt+P** to open the configurable in-game quick overlay. Opening it
stops and neutralizes active capture before allowing profile changes. The
overlay shows the route-detected game, current profile, capture state, and
bounded hip/ADS sensitivity controls. For native video fullscreen, the shortcut
exits fullscreen before displaying the overlay because HTML cannot render above
that surface.

Click **View / edit mappings** in the extension popup to see keyboard and mouse
bindings, browse/search bundled generic FPS, third-person/action, racing,
platformer, and one-handed accessibility presets, and tune separate hip and
aim-down-sights (ADS) mouse response. Profiles can store normalized product IDs,
game names, and aliases. The extension observes only documented-style
`/play/games/<title-slug>/<productId>` URLs and SPA navigation; it does not read
the page DOM, authentication data, or Xbox traffic. A unique exact product ID or
explicit alias selects a profile. Ambiguous names display a non-blocking choice,
and an explicit choice stores the product association locally.
The extension stores settings locally and requests no Native Messaging
permission. See `docs\browser-only-mode.md` for limitations.

## Development

Prerequisites:

- Node.js 22 or newer
- Rust stable
- Chrome or Microsoft Edge

```powershell
npm install
npm run check
npm run build
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

The unpacked extension is produced in `apps\extension\dist`.

The native host can be exercised without installing it:

```powershell
cargo run -p xib-companion -- --native-messaging
```

On Windows, developers can exercise non-suppressing Raw Input capture against
the fake backend. Both a target PID and the explicit activation switch are
required; the adapter verifies that exact executable remains foreground and
neutralizes on focus/device/session/desktop/power/process failures:

```powershell
cargo run -p xib-companion -- --local-diagnostics --target-pid <PID> --activate
```

`Ctrl+Alt+F12` is checked before mapping as the emergency release chord. This
diagnostic mode does not inject code or input, modify processes, elevate,
bypass anti-cheat, access the network, or suppress physical input.

The browser-only extension does not register a Native Messaging host. Companion
developers can use a development manifest that grants `nativeMessaging`, then
register its extension ID:

```powershell
.\installer\Install-NativeHost.ps1 `
  -ExtensionId '<32-character-extension-id>' `
  -CompanionPath '.\target\release\xib-companion.exe'
```

Do not distribute that development setup as a working controller emulator: the
backend deliberately remains fake until the driver release gate is satisfied.

## Safety

Input capture is opt-in, limited to Xbox Cloud Gaming in the browser, and
always returns the virtual controller to neutral on disconnect or timeout.
There is no telemetry, networking, cloud sync, macro, turbo, or remote code.

See `docs\threat-model.md`, `docs\architecture.md`, and
`docs\driver-evaluation.md` for the security and release constraints.
