# Privacy

Xbox Input Bridge processes keyboard and mouse events locally and in memory
only while the user has explicitly activated capture.

- Raw keyboard and mouse events are not stored, logged, transmitted, sold, or
  used for analytics.
- The extension runs only on Xbox Cloud Gaming pages under `www.xbox.com`.
- The browser-only extension processes captured input locally in the matched
  Xbox Cloud Gaming page. It requests no Native Messaging permission and has no
  network client, telemetry SDK, advertising, or cloud synchronization.
- Profiles are intended to remain local. Export, when implemented, will require
  an explicit user action.
- Diagnostic messages contain coarse connection and error state, never raw
  input payloads.

Capture stops on user request, pointer-lock loss, page blur, hidden document,
companion disconnect, protocol error, input overflow, or watchdog timeout.
Uninstalling the extension and running `installer\Uninstall-NativeHost.ps1`
removes the browser-to-companion registration.
