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
- Game detection reads only the current URL's stable-style
  `/play/games/<title-slug>/<productId>` route and SPA URL changes. It does not
  inspect arbitrary DOM, authentication state, or Xbox network traffic.
- The release manifest does not request Native Messaging permission.

The isolated extension script transfers a `MessageChannel` to the MAIN-world
gamepad shim on activation. The channel uses a bounded acknowledgement/retry
handshake and retains earlier candidates until their delayed ACKs arrive. The
MAIN-world shim has no access to extension APIs and cannot forward page data to
native code.

Keyboard presses and releases flush immediately, including any pending mouse
movement in event order, rather than waiting for the 8 ms movement batching timer.
Mouse-button presses also flush immediately. Quick mouse-button releases are
delayed only until 40 ms after their press to help gamepad polling observe taps;
longer holds release immediately. Capture loss cancels pending releases and
neutralizes output.

For sluggish aiming, compare both hip and ADS settings with smoothing `0`, a
linear curve, and velocity scaling `0`. This removes response filtering without
claiming to remove streaming latency. Existing saved profiles are not changed
automatically. The diagnostics bridge round trip excludes time waiting for the
movement batch and does not measure Xbox network, rendering, or video latency.
Mouse-to-stick emulation remains subject to each game's controller turn limit.

In browser mode, keyboard and non-ADS button-only updates preserve the last
right-stick output instead of interrupting aiming. Mouse idle is declared after
24 ms without a movement event, checked by the 8 ms timer (normally 24-32 ms
after the last event; browser scheduling can delay it). This bridges short gaps
between mouse samples without adding a wait before movement is sent. It trades
a bounded normal stop tail for fewer unintended recentering pulses. Empty
batches explicitly neutralize aim; ADS changes reset the response, and capture
loss still neutralizes immediately rather than waiting for the idle timer.

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
render the HTML prompt: use **Ctrl+Alt+G** instead. **Ctrl+Alt+P** opens the
quick overlay by leaving native fullscreen first; its shortcut can be changed
in the profile editor. The capture shortcut also works in
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

## Onboarding and PC-oriented mapping

The versioned first-run guide is stored only in extension-local storage. It can
be skipped or restarted and does not listen for gameplay input. It explains
browser-only scope, lets the user choose a PC-genre starter layout, checks local
Pointer Lock and storage readiness, introduces sensitivity calibration, and
links into the mapping editor.

Simple mapping mode is the default. It presents familiar PC actions and friendly
source labels such as **W**, **Left Shift**, and **Left Mouse**, followed by the
controller target as explanatory text. Presets provide these action suggestions;
they are not guarantees of a game's behavior because games decide what each
standard controller input does. Advanced mode exposes canonical
`KeyboardEvent.code` values and raw controller targets. Visual capture preserves
canonical values internally, rejects duplicates and unsupported mouse buttons,
preserves multi-target bindings, and reserves `Escape` for cancellation and
capture release.

The controller diagram is an original SVG/CSS rendering rather than a copied
brand asset. Its focusable controls and adjacent text list expose the same
mapping information, while calibration reports live right-stick values through
a polite live region.

## Localization and accessibility

All popup, options, onboarding, activation-prompt, and quick-overlay UI strings
use bundled MV3 locale catalogs. English is the declared default and fallback;
Spanish, Brazilian Portuguese, and Hindi are included. Programmatic key codes,
profile IDs, URL identifiers, and protocol values are not translated.

The extension provides visible keyboard focus, a skip link, native modal focus
containment during onboarding, labeled controls, status live regions, textual
state in addition to color, a persistent high-contrast preference, and CSS
support for `prefers-contrast`, `forced-colors`, and
`prefers-reduced-motion`. This is an accessibility-focused implementation, not
a claim of formal WCAG conformance.

## Profile and response semantics

Profile schema v2 stores separate hip and ADS response settings. ADS is active
while one configured, existing keyboard or mouse binding is held; selecting no
source keeps hip response active. Version 1 documents migrate locally by copying
their former mouse settings to both modes, disabling smoothing and velocity
scaling, and leaving ADS activation and game associations unset. This preserves
their prior mapping behavior. Import and export remain local JSON operations,
and unknown fields, duplicate product IDs, unsupported sources, and non-finite
or out-of-range values are rejected before save or activation. Ambiguous names
are retained so the user can resolve them explicitly instead of the extension
guessing.

For each input batch and axis, response processing is deterministic:

1. Multiply relative movement by axis sensitivity.
2. If velocity scaling is nonzero, multiply by
   `1 + velocity_scale × min(abs(delta) / 100, 1)`.
3. Clamp to the stick range, remove and rescale the configured deadzone, then
   apply the selected linear, squared exponential, or cubic precision curve.
4. For consecutive nonzero movement samples, smoothing produces
   `previous × smoothing + current × (1 - smoothing)`.

The first sample after idle or a hip/ADS change is unsmoothed. An explicit empty
batch clears smoothing state and emits a centered right stick immediately;
reset, capture loss, and deactivation also clear it. Smoothing therefore never
extends input after capture stops. Sensitivity is bounded to `0.001-0.2`,
deadzone and smoothing to `0-0.95`, and velocity scaling to `0-4`.

Profiles may contain normalized lowercase product IDs, title names, and aliases.
A unique exact product ID or explicit name/alias match selects the profile
locally. Product IDs take precedence. Ambiguous alias matches never select a
profile automatically; the quick overlay shows the candidates, and the user's
choice is saved as an exact product association. Switching while capture is
active neutralizes held controller state before applying the replacement.

The bundled preset catalog contains generic, offline-only FPS,
third-person/action, racing, platformer, and one-handed accessibility mappings.
Preset search filters local profile data and performs no network request.

Chrome 120 or newer is the minimum declared version. Current Chrome and Edge
must each pass live xCloud testing before a store release or game-compatibility
claim.
