# Compatibility status

The driverless browser backend is implemented for Xbox Cloud Gaming. It has not
yet completed live game-session compatibility testing, so no per-game or
universal compatibility claim is made.

## Implemented and build-validated

- Chrome Manifest V3 extension build
- driverless virtual standard Gamepad API backend
- Xbox Cloud Gaming origin restriction
- bounded, versioned Native Messaging protocol
- deterministic keyboard/mouse mapping
- companion heartbeat timeout and neutralization
- fake controller backend lifecycle
- local-only profile editing, validation, import/export, calibration, curve
  preview, runtime transfer, and atomic application
- Windows Raw Input diagnostic capture with foreground/process/device/session
  fail-safe handling and emergency release

Explicit pointer-lock activation, bridge retry/acknowledgement, stable virtual
gamepad indexing, and immediate browser stop paths are implemented. Live
Chrome/Edge xCloud sessions remain the release compatibility gate.

## Browser lifecycle checks (2026-09-20)

Automated checks on the actual `https://www.xbox.com/en-US/play` route passed
in Chrome for Testing 153.0.8010.52 and Microsoft Edge 146.0.3856.109:
pointer-lock activation, held-button mapping, 32-second service-worker liveness,
neutralization on pointer-lock loss, reactivation, live profile replacement,
and SPA navigation cleanup.

Fullscreen container/video fixtures on the same route also passed: top-layer
activation prompt visibility in containers, click activation, Ctrl+Alt+G
start/stop in native video fullscreen, and preserving fullscreen when stopping
via the shortcut.

These are browser plumbing checks, not authenticated cloud-game sessions.
Game launch, in-game behavior, physical-controller hardware coexistence, and
end-to-end latency still need game/hardware testing. Unit coverage exercises
simulated physical-controller index collisions and delayed activation/bridge
acknowledgements.

## Not yet enabled

- Windows virtual Xbox controller output
- production local-game UX and optional physical-input suppression
- Chrome Web Store distribution
- signed companion installer and update channel

When a production backend is selected, this document will become a dated matrix
of Windows version and architecture, browser version, xCloud title/genre, local
game input API, fullscreen mode, launcher, privilege level, and anti-cheat
result. A pass means tested behavior for that exact configuration, not universal
compatibility.
