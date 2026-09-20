# Privacy

Xbox Input Bridge processes keyboard and mouse events locally and in memory
only while the user has explicitly activated capture.

- Raw keyboard and mouse events are not stored, logged, transmitted, sold, or
  used for analytics.
- The extension runs only on Xbox Cloud Gaming pages under `www.xbox.com`.
- The browser-only extension processes captured input locally in the matched
  Xbox Cloud Gaming page. It requests no Native Messaging permission and has no
  network client, telemetry SDK, advertising, or cloud synchronization.
- Profiles remain local. Export requires an explicit user action.
- Onboarding completion/skip state and the high-contrast preference remain in
  extension-local storage. Restarting onboarding does not transmit or capture
  input.
- Automatic profile selection reads only the current xCloud route's title slug
  and product ID. It does not read arbitrary page content, account/session data,
  or Xbox network traffic. Explicit game/profile associations remain in local
  extension storage.
- Diagnostic messages contain coarse connection and error state, never raw
  input payloads.

Capture stops on user request, pointer-lock loss, page blur, hidden document,
companion disconnect, protocol error, input overflow, or watchdog timeout.
Uninstalling the extension and running `installer\Uninstall-NativeHost.ps1`
removes the browser-to-companion registration.
