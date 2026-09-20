# Browser-only mode

Browser-only mode converts captured keyboard and mouse events into a virtual
standard gamepad visible through `navigator.getGamepads()` on matched Xbox Cloud
Gaming pages. It works in Chrome and Microsoft Edge without a companion,
administrator access, or controller driver.

## Security and privacy

- Capture starts only after the user clicks the in-page activation prompt or
  presses **Ctrl+Alt+G** on a focused Xbox play page. The popup's **Start capture**
  button and entering a fullscreen game container display the prompt without
  capturing.
- Capture is restricted to HTTPS pages on `www.xbox.com` at `/play` or
  `/<language>-<region>/play`, including their game subpaths.
- `Esc`, focus loss, page hiding, pointer-lock loss, navigation, and extension
  deactivation stop capture and return all controls to neutral.
- Input and profiles remain local. There is no telemetry, advertising, remote
  code, cloud sync, or network client.
- The release manifest does not request Native Messaging permission.

The isolated extension script transfers a `MessageChannel` to the MAIN-world
gamepad shim on activation. The channel uses a bounded acknowledgement/retry
handshake and retains earlier candidates until their delayed ACKs arrive. The
MAIN-world shim has no access to extension APIs and cannot forward page data to
native code.

Input batches bypass the service worker, but a one-second control heartbeat keeps
the worker informed of capture ownership. A restarted worker stops orphaned
capture rather than silently adopting it. A separate 250 ms page heartbeat lets
the MAIN-world shim neutralize and disconnect after 1.5 seconds without capture
liveness (subject to browser timer scheduling). Focus and pointer-lock loss
also disconnect directly in both worlds.

Stopping invalidates pending activation work. A second tab cannot stop or submit
input for another tab's capture; starting in a different tab releases the old
session. Navigating away from the play route, including SPA navigation, stops
capture. Profile replacement clears held state before applying new bindings.

## Fullscreen activation

The activation button is placed inside the fullscreen game container and uses
the browser's popover top layer. Entering site fullscreen shows the button while
inactive; click it to grant pointer lock. Native video/canvas fullscreen cannot
render the HTML prompt: use **Ctrl+Alt+G** instead. The shortcut also works in
browser fullscreen (F11), which does not fire the site's `fullscreenchange`
event. The shortcut is reserved for capture control and is not forwarded to
the mapper.

Stopping or pressing Esc does not immediately restart capture or re-open the
prompt. Use the shortcut or re-enter site fullscreen to start again.

## Compatibility limits

This mode is xCloud-only. It does not create an operating-system controller and
cannot affect installed Windows games. It preserves physical controllers and
adds one virtual standard-mapped gamepad, but websites can change their input
detection and may reject JavaScript-supplied Gamepad-shaped objects.

Mouse movement is translated to right-stick values. It therefore remains
subject to each game's controller deadzone, acceleration, maximum turn speed,
and aim-assist behavior and cannot match native mouse aiming exactly.

## Profile and response semantics

Profile schema v2 stores separate hip and ADS response settings. ADS is active
while one configured, existing keyboard or mouse binding is held; selecting no
source keeps hip response active. Version 1 documents migrate locally by copying
their former mouse settings to both modes, disabling smoothing and velocity
scaling, and leaving ADS activation and game associations unset. This preserves
their prior mapping behavior. Import and export remain local JSON operations,
and unknown fields, ambiguous game associations, unsupported sources, and
non-finite or out-of-range values are rejected before save or activation.

For each input batch and axis, response processing is deterministic:

1. Multiply relative movement by axis sensitivity.
2. If velocity scaling is nonzero, multiply by
   `1 + velocity_scale × min(abs(delta) / 100, 1)`.
3. Clamp to the stick range, remove and rescale the configured deadzone, then
   apply the selected linear, squared exponential, or cubic precision curve.
4. For consecutive nonzero movement samples, smoothing produces
   `previous × smoothing + current × (1 - smoothing)`.

The first sample after idle or a hip/ADS change is unsmoothed. A zero-movement
batch clears smoothing state and emits a centered right stick immediately;
reset, capture loss, and deactivation also clear it. Smoothing therefore never
extends input after capture stops. Sensitivity is bounded to `0.001-0.2`,
deadzone and smoothing to `0-0.95`, and velocity scaling to `0-4`.

Profiles may contain normalized lowercase title IDs, title names, and aliases.
They are metadata only in this layer: the extension does not inspect the xCloud
DOM, detect the running title, or automatically select a profile.

Chrome 120 or newer is the minimum declared version. Current Chrome and Edge
must each pass live xCloud testing before a store release or game-compatibility
claim.
