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

## Automated browser matrix (2026-09-20)

Command:

```powershell
npm run integration:browser -- --browser all
```

The runner uses a fresh temporary profile, loads the bundled extension, visits
the public unauthenticated `https://www.xbox.com/en-US/play` route, and deletes
the profile afterward. It does not use credentials or launch a game.

| Environment | Result | Exact automated coverage |
| --- | --- | --- |
| Microsoft Edge 146.0.3856.109, Windows x64 | Pass | Unpacked MV3 load, exact-route injection, idle content/MAIN handshake, active watchdog response, pointer-lock activation, held W mapping, 32-second held input with the service-worker debugger detached and worker recovery afterward, atomic profile switch, Escape neutralization, container and video fullscreen shortcuts with fullscreen preserved on stop, SPA navigation cleanup |
| Chrome for Testing 153.0.8010.52, Windows x64 | Pass | Same complete automated path as Edge, using `--browser chrome --executable <path-to-chrome-for-testing.exe>` |
| Google Chrome Stable 153.0.8010.48, Windows x64 | Blocked | Browser version was detected, but this branded Stable build rejected command-line unpacked-extension loading; no extension behavior is claimed for this run |

The Edge and Chrome for Testing results are browser plumbing coverage, not game
compatibility results. The `--executable` override requires selecting one browser
and exists so the same suite can run against approved Chromium test binaries.
Unit coverage also exercises physical-controller index collisions, delayed
activation/bridge acknowledgements, aggregate bounds, privacy-safe export,
failure counters, self-test results, localization completeness, and closed
overlay lifecycle.

## Explicitly untested

- authenticated game launch and in-game response;
- coexistence with physical-controller hardware;
- network or game-stream latency;
- production Windows virtual-controller drivers and installed games;
- universal browser, game, hardware, or regional compatibility.

The diagnostics panel intentionally labels MAIN-world mapping duration as
measured and isolated-world bridge round trip as estimated. Neither value is a
network-latency or game-stream-latency measurement.

## Not yet enabled

- Windows virtual Xbox controller output
- production local-game UX and optional physical-input suppression
- Chrome Web Store distribution
- signed companion installer and update channel

When a production backend is selected, this document will expand into a dated matrix
of Windows version and architecture, browser version, xCloud title/genre, local
game input API, fullscreen mode, launcher, privilege level, and anti-cheat
result. A pass means tested behavior for that exact configuration, not universal
compatibility.
