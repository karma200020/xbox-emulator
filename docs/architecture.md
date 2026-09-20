# Architecture

## Scope and principles

This project converts keyboard and mouse input into ordinary virtual-controller
state for approved Xbox cloud and local-game use. It consists of:

- a driverless Chrome Manifest V3 extension restricted to Xbox Cloud Gaming;
- a Rust Windows companion;
- a deterministic Rust mapping core for native modes, mirrored in TypeScript for
  browser mode; and
- a versioned Native Messaging protocol for companion development builds.

The system deliberately excludes macros, turbo/repeat automation, network
services, and telemetry. Input is processed locally. Control is opt-in:
installation alone never activates remapping, and every shutdown, disconnect,
or error path publishes a neutral controller state.

## Components

### Chrome extension

The extension is scoped by manifest host permissions and runtime checks to the
approved Xbox Cloud Gaming origins. Its responsibilities are:

- present clear enable/disable state and require an explicit user action to
  activate;
- capture permitted keyboard and mouse events while an eligible xCloud page is
  focused;
- map validated browser events to a standard Gamepad API shape in the page's
  MAIN world through a private acknowledged `MessageChannel`;
- exchange framed, versioned messages with the Windows companion only in an
  explicitly permissioned development build;
- stop capture and request neutral state on blur, navigation, tab closure,
  extension suspension, protocol error, or user deactivation; and
- display companion, protocol, and activation status without collecting usage
  data.

The release service worker manages activation and profiles. A narrowly injected
isolated content script handles page-focused input capture, while a MAIN-world
shim exposes the virtual standard gamepad to xCloud. Configuration UI validates
mappings before activation. No remotely hosted code, dynamic script download,
Native Messaging permission, or general web-origin access is permitted.

Manifest V3 service workers can be suspended at any time. Safety therefore
does not depend on a browser-side cleanup message: the companion also applies a
short input lease/watchdog and independently neutralizes output when messages
stop.

### Native Messaging host

The installed Rust executable is registered as a Native Messaging host for the
extension's exact ID. It:

- validates Chrome's launch context and every incoming frame;
- negotiates a compatible protocol version before accepting input;
- enforces message size, type, ordering, and value bounds;
- owns activation leases and controller lifecycle;
- routes xCloud input samples into the mapping core; and
- reports bounded status and errors to the extension.

Native Messaging uses length-prefixed JSON over standard input/output. Standard
output contains protocol frames only; diagnostics go to a local, size-bounded
log only when explicitly enabled. The protocol is versioned independently of
the application.

### Local input service

For local games, the companion registers Windows Raw Input devices and consumes
keyboard and mouse input directly. Local mode requires explicit activation and
selection of the target session or game. It does not depend on Chrome.

Optional physical-input suppression is a separate, elevated capability. It is
off by default, visibly indicated, limited to the active local-mode session,
and must have an emergency release chord that is never suppressible. Loss of
focus, target exit, watchdog expiry, privilege failure, or companion shutdown
immediately disables suppression and neutralizes the controller.

### Deterministic mapping core

The mapping core is a Rust library used by both xCloud and local modes. Its
inputs are:

- a validated mapping configuration;
- normalized key/button transitions;
- relative pointer deltas;
- explicit timestamps or fixed ticks supplied by the caller; and
- lifecycle events such as activate, focus lost, reset, and deactivate.

Its output is a complete controller snapshot: buttons, triggers, and signed
stick axes. The core performs no I/O, reads no wall clock, uses no randomness,
and has no mode-specific behavior. Given the same initial state and ordered
input sequence, it produces the same snapshots. Saturation, dead zones,
sensitivity, and rounding are specified and tested. Each reset discards held
inputs and emits exactly neutral output.

One physical transition maps only to contemporaneous controller state.
Sequences, delayed actions, recording/playback, turbo, and macros are outside
the model and rejected by configuration validation.

### Controller backend adapter

A narrow adapter translates complete controller snapshots into calls to a
Windows virtual-controller backend:

```text
create() -> controller handle
publish(handle, complete snapshot)
neutralize(handle)
destroy(handle)
health() -> status
```

The mapping core never imports driver-specific APIs. Backend calls are
serialized, and partial field updates are not exposed. The production driver
selection is intentionally deferred until compatibility, licensing, signing,
maintenance, and security requirements have been evaluated. Development
backends must not be represented as production-ready.

## Operating modes

### xCloud mode

1. The user opens an allowed xCloud origin.
2. The extension confirms page eligibility and companion compatibility.
3. The user explicitly enables mapping for the focused tab.
4. The extension sends normalized input samples under a renewable activation
   lease.
5. The companion validates and orders samples, runs the mapping core, and
   publishes full snapshots through the backend adapter.
6. Blur, navigation, disconnect, timeout, or disable ends the lease and emits
   neutral state.

Only one tab may own an xCloud activation lease. A newly requested owner cannot
take control until the previous owner has been neutralized.

### Local-game mode

1. The user starts the companion and selects local mode.
2. The user explicitly activates a target session.
3. Raw Input events flow directly to the mapping core.
4. Complete snapshots flow to the controller adapter.
5. Optional suppression, if separately enabled, applies only while all target,
   focus, lease, and emergency-release checks remain healthy.
6. Deactivation or any failed check releases suppression and publishes neutral
   state before the controller is destroyed.

xCloud and local modes are mutually exclusive. Mode switching is a
neutralize-then-activate transaction, never an in-place source swap.

## Protocol and data flow

Every Native Messaging envelope contains:

- protocol major and minor version;
- message type;
- monotonically increasing session sequence number;
- random per-process session identifier generated by the companion;
- activation lease identifier where applicable; and
- a type-specific payload with strict bounds.

Handshake messages advertise supported versions and capabilities. Major
version mismatches fail closed. Minor features are used only when advertised
by both sides. Unknown message types, duplicate or out-of-order sequence
numbers, oversized frames, invalid enum values, non-finite numbers, and values
outside defined ranges terminate activation and neutralize output.

The release xCloud flow is:

```text
Keyboard/mouse
  -> isolated xCloud content script
  -> MessageChannel
  -> browser mapping core (MAIN world)
  -> MAIN-world virtual standard gamepad
  -> xCloud client/game
```

The service worker authorizes activation and supplies the selected validated
profile, but input batches bypass it after browser activation to avoid MV3 wake
latency. A separate control heartbeat maintains ownership and worker liveness;
the MAIN-world watchdog disconnects if content-script heartbeats stop.
Companion-enabled development builds use the Native Messaging flow
described below; that permission is absent from the release manifest.

The local flow is:

```text
Keyboard/mouse -> Windows Raw Input -> companion
  -> deterministic mapping core -> controller backend adapter
  -> Windows virtual controller -> local game
```

Configuration follows the same authenticated local channel but is validated
and applied atomically. Invalid or partially received configuration never
replaces the last valid inactive configuration. Mapping changes while active
first neutralize, reset core state, then activate with the new configuration.

Profile schema v2 carries bounded hip and ADS response settings plus optional
normalized game-association metadata. The browser and Rust mappers use the same
ADS source, velocity-scaling, curve, and smoothing semantics. The v1 migration
copies the former response into both modes with all advanced effects disabled.
The isolated content script derives game identity only from stable-style
`/play/games/<title-slug>/<productId>` routes and observes URL changes during
SPA navigation. The service worker compares normalized product IDs first, then
explicit normalized names and aliases. It selects only a unique match; ambiguous
aliases surface a local overlay choice. An explicit choice stores an exact
product association locally. The implementation does not inspect arbitrary DOM,
intercept Xbox traffic, access authentication state, or send network requests.

The in-game quick overlay uses a configurable shortcut distinct from
**Ctrl+Alt+G** and `Esc`. Opening it neutralizes active capture before editing.
Live profile replacement is a neutralize-then-apply transaction in both browser
and companion modes. Runtime messages use exact-key validation, and the service
worker accepts game/profile commands only from the top frame of the owning
eligible Xbox tab.

## Failure handling and invariants

Neutral means all buttons released, triggers zero, and both sticks centered.
The companion maintains this state as the safety default.

It neutralizes immediately on:

- explicit disable or mode change;
- tab/window blur, ineligible navigation, or target-game exit;
- Native Messaging EOF, malformed input, version failure, or sequence error;
- activation lease/watchdog timeout;
- mapping-core validation or processing error;
- virtual-controller backend error or unhealthy status;
- Raw Input device removal;
- suppression setup or teardown error; and
- normal shutdown, panic handling, or service termination where cleanup is
  possible.

After neutralization, recovery requires a fresh handshake and explicit
activation; input does not silently resume. If publishing neutral state itself
fails, the adapter destroys the virtual device. The backend watchdog or driver
lifecycle must ensure that process death cannot leave a latched controller.

## Why Gamepad API monkey-patching is unnecessary

The browser's Gamepad API reports controllers that the operating system exposes
to Chrome. Once the Windows companion creates a real virtual controller,
Chrome and the xCloud web client discover and read it through their normal
controller path. The extension only supplies physical input to the companion;
it does not need to replace `navigator.getGamepads`, synthesize JavaScript
events, modify page objects, or race application polling.

Avoiding monkey-patching reduces origin-page privileges, compatibility risk,
detectability, and exposure to page-script conflicts. It also gives xCloud and
local games the same deterministic mapping behavior and failure semantics.

## Explicit non-goals

- macros, recorded sequences, turbo, timed repeat, or automation;
- remote control, network listeners, cloud configuration, or telemetry;
- credentials, account data, game traffic, or page-content inspection;
- bypassing game, platform, or anti-cheat policy;
- broad browser support or arbitrary-site injection; and
- selecting or bundling a production virtual-controller driver before review.
