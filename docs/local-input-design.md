# Windows Local-Game Input Design

## Scope and safety contract

This design covers keyboard and mouse input for the Rust companion on supported
Windows 10 and Windows 11 releases. Local mode is user-mode, per interactive
user, opt-in, and mutually exclusive with xCloud mode. It does not inject a DLL,
modify or inspect a game, synthesize game-process events, evade anti-cheat, or
select a virtual-controller or suppression driver. Games and anti-cheat systems
may reject any virtual controller or suppression technology; the product must
state that limitation and defer to their policies.

The implementation must preserve these invariants:

1. Merely starting the companion never captures for mapping, suppresses physical
   input, or creates active controller output.
2. Activation is bound to one user-selected executable instance in the current
   interactive session and default input desktop.
3. Input can affect controller state only while that exact instance owns the
   foreground window and every activation check is healthy.
4. Deactivation, ambiguity, overload, or failure first invalidates the
   activation generation, then requests a complete neutral controller snapshot,
   then releases optional suppression.
5. Suppression is a separate, optional consent and capability. It is off after
   every process start, crash, sign-out, desktop switch, suspend, and reboot.
6. A fixed emergency chord is recognized below the mapping layer and can never
   be remapped, suppressed, disabled, or made conditional on the target.
7. Raw keys, button states, and mouse movement are transient. They are not
   logged, persisted, transmitted, or intentionally included in crash reports.

“Immediately” below means at the next opportunity provided by Windows and the
component watchdogs; the design does not promise zero latency under an OS,
hardware, or kernel failure.

## Component and thread model

Keep lifecycle decisions in one companion-owned `LocalInputCoordinator`. It is a
state machine, not a collection of independent callbacks:

```text
Inactive
  -> Armed(target identity, devices, activation generation)
  -> Active(foreground confirmed, output lease)
  -> ActiveSuppressed(separate suppression lease)
  -> Deactivating
  -> Inactive
```

Any failed prerequisite moves to `Deactivating`; no error path transitions
directly back to active. Returning from `Deactivating` requires all queued input
from the old generation to be discarded, neutral publication (or controller
destruction if publication fails), suppression release acknowledgement or
watchdog expiry, and a fresh explicit activation.

Use these execution domains:

- **Win32 input thread:** creates the hidden window, registers Raw Input, and
  owns its message pump. It parses packets into bounded, allocation-free
  normalized records. It never calls the controller backend or blocks on UI,
  disk, IPC, process queries, or mapping.
- **Coordinator thread:** serializes target eligibility, device lifecycle,
  activation generations, mapping-core calls, and complete controller
  snapshots.
- **Foreground/session monitor:** turns WinEvent, session, desktop, process, and
  power notifications into coordinator events. A low-rate independent
  foreground recheck closes notification races.
- **Watchdog:** uses monotonic time and cannot share the input queue or mapping
  loop. It invalidates output and suppression leases when coordinator progress
  or the target liveness deadline expires.
- **Optional suppression component:** is isolated from Raw Input and mapping,
  exposes only a narrow lease API, and independently fails open for physical
  input. Its privilege and implementation depend on a later approved
  technology; this document does not choose one.

All cross-thread records carry an activation generation and monotonic sequence.
Consumers discard records from old generations. Queues are bounded. Lifecycle
and emergency-release events use a reserved priority path that cannot be
starved by mouse traffic.

## Raw Input window and message loop

### Window ownership

The input thread initializes COM only if a chosen safe wrapper requires it,
registers a private random-looking window class, and creates a message-only
window under `HWND_MESSAGE`. The window has no UI, taskbar entry, or activation
behavior. The thread executes `GetMessageW`/`TranslateMessage`/`DispatchMessageW`
until a coordinator-issued shutdown message. Creation and registration failures
leave local mode unavailable and neutral.

Register keyboard (`UsagePage 0x01`, `Usage 0x06`) and mouse
(`UsagePage 0x01`, `Usage 0x02`) with `RIDEV_INPUTSINK | RIDEV_DEVNOTIFY` and the
hidden window as the target. `INPUTSINK` is required so event observation
continues long enough to detect releases around foreground transitions; the
coordinator still rejects mapping and output while the selected target is not
eligible. Do not use `RIDEV_NOLEGACY` as system-wide suppression: it only changes
legacy-message generation for the registering process and is not the optional
suppression feature.

Raw Input registration is process-global for each top-level collection and only
one target window per class is supported. Therefore only this module may call
`RegisterRawInputDevices`; libraries must not register independently. On orderly
shutdown, remove registrations with `RIDEV_REMOVE` and a null target.

Handle:

- `WM_INPUT`: call `GetRawInputData`, validate the returned byte count, header
  type, structure bounds, and keyboard/mouse union before normalization. Always
  perform the cleanup behavior required by `DefWindowProcW`, including malformed
  foreground packets.
- `WM_INPUT_DEVICE_CHANGE`: process `GIDC_ARRIVAL` and `GIDC_REMOVAL`; never
  dereference a removed handle.
- the private shutdown and health-probe messages;
- `WM_POWERBROADCAST` and registered session notifications as described below.

Unknown device types and HID reports are ignored; v1 registers only keyboard and
mouse top-level collections. Malformed or contradictory records invalidate the
affected device state. Repeated API failures or queue overload deactivate the
entire local session rather than continuing with uncertain held keys.

### High polling rates

An 8 kHz mouse can produce bursts faster than UI or controller publication.
The window procedure must do bounded work:

- preallocate packet scratch space up to a documented cap and use
  `GetRawInputBuffer` batching where the wrapper exposes it correctly;
- otherwise use a small stack/header read followed by reusable thread-local
  storage for `GetRawInputData`, with checked size growth capped well below an
  untrusted allocation size;
- preserve key and button transitions in order;
- accumulate consecutive relative mouse deltas only within the same device,
  activation generation, eligibility epoch, and mapping tick, using checked
  saturating arithmetic;
- never coalesce across a button/key transition, device change, focus change,
  reset, or emergency event;
- use a bounded single-producer queue and publish watermark/overrun status
  without recording packet contents.

The mapping tick consumes all eligible transitions up to its cutoff and one
deterministically accumulated relative delta. Absolute mouse packets are either
converted by a separately specified, tested rule or rejected in v1; they must
not be silently interpreted as relative deltas. On queue exhaustion, sequence
gap, arithmetic saturation beyond configured bounds, or sustained inability to
meet deadlines, invalidate the generation, clear all held state, neutralize,
release suppression, and require explicit reactivation. Dropping an isolated
key-up event is never acceptable.

## Device identity and hotplug

Treat `RAWINPUTHEADER.hDevice` as an ephemeral routing handle, not a durable
identity. On initial enumeration and `GIDC_ARRIVAL`, query:

- `RIDI_DEVICENAME` (the device interface path);
- `RIDI_DEVICEINFO` with its size initialized correctly;
- top-level usage, type, keyboard subtype/function-key count, or mouse
  capabilities where available; and
- a session-local monotonically assigned `DeviceInstanceId`.

Normalize the interface path only for comparison; preserve Windows'
case-insensitive semantics and do not parse undocumented path segments as a
guaranteed serial number. VID/PID text, when present, is diagnostic metadata,
not proof of physical identity. Persisted per-device selection may use a
privacy-preserving keyed digest of the normalized interface path plus usage and
documented capabilities, but must tolerate re-enumeration changing the path.
The UI should show friendly, non-unique labels and require confirmation when
multiple devices are indistinguishable.

Maintain `hDevice -> DeviceRecord` only for the current enumeration epoch.
Arrival creates a fresh record even if its path resembles a removed device.
Removal atomically:

1. marks the record dead so later queued packets are ignored;
2. synthesizes no releases from guessed state;
3. clears all mapping-core state contributed by that device through a reset;
4. neutralizes the complete controller state; and
5. releases suppression and requires explicit reactivation.

At startup, resume, or detected notification loss, enumerate all Raw Input
devices and reconcile by creating a new epoch. A packet from an unknown handle
triggers bounded re-enumeration; if unresolved, fail closed. Device replacement
never inherits held state or an activation lease.

## Selecting and scoping the foreground executable

Selection occurs while inactive through a standard Windows file picker or a list
of visible processes. Store the canonical executable path and a user-facing
display name; do not accept a bare filename such as `game.exe`. At activation:

1. obtain the selected process with `PROCESS_QUERY_LIMITED_INFORMATION |
   SYNCHRONIZE`;
2. resolve its full image path with `QueryFullProcessImageNameW`, normalize
   case/path prefixes, and where possible resolve the opened file handle's final
   path;
3. record PID, process creation time, process handle, canonical image path, user
   SID, Windows session ID, and integrity level as the target instance;
4. reject PID reuse by checking the retained process handle and creation time;
5. reject a different executable at the same configured path until the user
   confirms selection again if the file identity changed during activation.

Code-signing or file hashes may be displayed as additional identity evidence but
are not required authorization and must not be computed on the input thread.
Launchers and child processes are not implicitly trusted: if the foreground
window moves from the selected launcher to a game child, mapping deactivates and
the user explicitly selects that executable. Packaged applications whose
foreground host cannot be resolved to the selected executable are unsupported
until a separately specified package-identity model exists.

Use an out-of-context `SetWinEventHook` for `EVENT_SYSTEM_FOREGROUND` plus
`GetForegroundWindow` and `GetWindowThreadProcessId`. Hooks enqueue hints only;
the coordinator independently verifies the live window PID, target process
handle, creation time, session, desktop, and image identity before entering or
remaining active. Recheck at a modest interval (for example 100 ms) and
immediately before enabling suppression. Minimized, cloaked, destroyed,
non-interactive, or zero-PID windows are ineligible. A race, query denial, hung
window, or ambiguous ownership is a focus loss.

On focus loss, invalidate the generation before processing later packets,
neutralize, and release suppression. Refocusing may return to the armed state,
but output and suppression remain inactive until a new explicit activation;
this avoids remapping keystrokes entered into another application during the
gap.

## Integrity levels and privilege mismatch

The companion normally runs at the interactive user's medium integrity level.
Read its and the target's token `TokenIntegrityLevel`, compare the mandatory
label RIDs, and also record elevation type, user SID, and session ID. If the
target has a higher integrity level, is protected, belongs to another user or
session, or cannot be queried, report a distinct `PrivilegeMismatch` or
`IdentityUnknown` state and fail closed.

Raw Input observation alone is not evidence that suppression is possible.
Windows UIPI and hook boundaries can prevent a lower-integrity component from
observing or suppressing input delivered to a higher-integrity target. Never
silently elevate the whole companion and never retry through injection. The UI
must explain that the target and companion need compatible privilege, with
suppression unavailable on uncertainty. If a future suppression technology
uses an elevated helper, the normal companion remains unelevated and the helper
must independently verify the caller's user, installation identity, session,
target, and lease. Elevation does not authorize secure-desktop capture.

## Optional reversible suppression

Suppression is an interface and safety protocol until a technology passes
security, compatibility, licensing, signing, servicing, anti-cheat-policy, and
uninstall review. This design neither selects nor requires a driver. Local
mapping must work without suppression.

The abstraction exposes only:

```text
capabilities() -> supported devices/events, privilege, emergency support
acquire(lease, target instance, session, desktop, expiry, allowlist)
renew(lease, expiry)
release(lease, reason)
health(lease) -> active | released | fault
```

There is no API for arbitrary event injection, process memory, game handles,
network access, persistent enablement, or changing the emergency chord.
Acquisition is allowed only after separate per-session informed consent, target
foreground verification, compatible integrity, healthy output, and a successful
dry-run capability check. A persistent and screen-reader-readable indicator
shows the exact devices/classes being suppressed.

The suppression component uses a short, monotonic lease (target: 250 ms, renewed
at least every 100 ms) and fails open when the lease expires, IPC closes,
the companion process handle signals, the target changes/exits, session or
desktop changes, suspend begins, health becomes uncertain, or emergency release
occurs. Its watchdog is independent of the companion's UI, Raw Input pump, and
mapping queue. The companion treats failure to confirm release within one lease
period as a critical fault: output is neutralized, the controller is destroyed
if needed, and activation remains locked out while recovery instructions are
shown.

Enabled state and leases are never persisted. Installation, update, rollback,
and uninstall must leave input unsuppressed. Any privileged IPC is local-only,
authenticated to the installed binaries, protected by restrictive ACLs, bound
to user and session, length/version bounded, replay resistant, and limited to
the operations above.

### Emergency release

Reserve the physical chord **Left Ctrl + Left Alt + Left Shift + F12 held for
two seconds**. Recognition uses hardware make/break state and scan codes before
mapping, focus, target, or suppression policy. The suppression component must
independently recognize it and always pass its constituent events through; the
companion also recognizes it as defense in depth. Injected events cannot satisfy
the chord. Auto-repeat does not advance the timer, and releasing any member
resets it.

On recognition, immediately expire the suppression lease, invalidate local
activation, neutralize/destroy output, clear held state, and latch an
`EmergencyReleased` condition that requires an explicit UI acknowledgement
before any reactivation. The chord is fixed for the release and excluded from
all mappings. Capability tests must prove that the chosen suppression technology
cannot intercept it without first running the emergency detector. If that
cannot be proved for a candidate, suppression must not ship with that candidate.
Windows' secure attention sequence remains untouched and is never suppressed.

The chord is not a substitute for fail-open watchdogs or reboot recovery.
Hardware/Fn layouts and accessibility needs can make it difficult to enter, so
suppression onboarding must test the chord before enabling the feature and must
offer a keyboard-free visible release control whenever the normal desktop is
available.

## Watchdogs, crash recovery, and output neutrality

The coordinator publishes a heartbeat containing only process/session identity,
activation generation, target liveness, and monotonic deadline. It contains no
raw input. Separate deadlines cover:

- input/coordinator progress;
- target foreground and process liveness;
- controller backend health;
- suppression lease renewal and release acknowledgement.

Timeout handling is idempotent. The first observer atomically invalidates the
generation; all observers then request complete neutral state and suppression
release. If neutral publication fails, destroy the virtual controller. Backend
process-death neutralization remains a release gate for whichever backend is
later selected.

Catch panics at thread ownership boundaries only to initiate best-effort
cleanup; do not resume input processing after a panic. Normal exit joins the
input thread, unregisters notifications/devices, releases suppression, sends
neutral, and destroys the controller. Abnormal exit is covered by the
suppression component watching the companion process handle and lease, plus the
backend's independently verified process-death behavior.

On next launch, assume prior state is unsafe but inactive: do not restore an
activation or suppression lease. Query suppression health, request an idempotent
release, wait at most one lease period, enumerate devices from a new epoch, and
create output only after explicit activation. Recovery diagnostics contain
coarse reason codes and timestamps, never input payloads.

## Session, desktop, and power lifecycle

Register the hidden window for `WTSRegisterSessionNotification` and handle lock,
unlock, logon, logoff, remote connect/disconnect, console connect/disconnect,
and session changes. Validate the process session with
`ProcessIdToSessionId`/active-console information; never follow another user's
foreground process. Fast user switching deactivates and releases suppression.
Use a single companion instance per user session, with any arbitration object
scoped and ACLed to that session rather than machine-wide.

Before activation and periodically while active, verify the thread/process is on
the current interactive **default input desktop**. A switch to Winlogon, UAC
secure desktop, screen saver desktop, or any non-default/unknown desktop
deactivates immediately. Do not switch desktops, open the secure desktop, or
attempt to capture it. Unlock or return to the default desktop only re-arms the
feature; explicit activation is required.

On `PBT_APMSUSPEND`, display-off/Modern Standby notification where available,
session disconnect, or shutdown query:

1. invalidate the generation;
2. request neutral/destroy;
3. release suppression and stop renewing its lease;
4. clear device and held-state epochs; and
5. acknowledge the lifecycle event without lengthy blocking.

Use `PowerRegisterSuspendResumeNotification` if needed to cover Modern Standby
consistently. On resume, recreate or verify the message window registrations,
enumerate devices into a new epoch, reopen the selected target identity, and
recheck session, desktop, integrity, foreground, and backend health. Remain
inactive until explicit user activation. Clock calculations use a monotonic
source and treat discontinuity as lease expiry.

## Accessibility and user experience

- Suppression is off by default and its consent clearly describes loss-of-input
  risk, emergency release, reboot recovery, and anti-cheat compatibility.
- Setup requires successfully performing the emergency chord before the enable
  control is unlocked. Explain that some compact keyboards require `Fn`.
- Provide a large mouse-operable release control, tray-menu release, keyboard
  navigation, visible focus, high-contrast support, and screen-reader names and
  live status. These controls supplement rather than replace the chord.
- Never disable or rewrite Sticky Keys, Filter Keys, Toggle Keys, Mouse Keys,
  Narrator, on-screen keyboard, or other Windows accessibility settings.
- Emergency recognition uses physical key state, not Sticky Keys semantics.
  Users unable to perform the chord should use mapping without suppression.
- Capability UI lets users exclude entire devices from suppression so an
  assistive keyboard or pointer remains usable. Ambiguous device identity blocks
  per-device suppression rather than risking the wrong device.
- Suppression must not interfere with the secure attention sequence, Windows
  sign-in, UAC secure desktop, or another user session.
- Status text distinguishes inactive, armed, active, suppressed, privilege
  mismatch, focus loss, watchdog release, and emergency release without exposing
  key names entered during play.

## Safe Rust and Win32 isolation

All existing workspace crates continue to inherit
`[workspace.lints.rust] unsafe_code = "forbid"`. The companion, coordinator,
mapping core, and controller adapter contain no `unsafe` blocks and depend only
on safe Rust interfaces.

Prefer a maintained Rust Windows wrapper whose public operations needed here are
safe. Unsafe code inside a registry dependency is outside the workspace lint but
must still pass provenance, license, maintenance, vulnerability, and API review.
Do not scatter raw `windows-sys` calls or handles through the companion.

If no reviewed wrapper can express the required APIs safely, create a dedicated,
small `win32-input-ffi` boundary crate in a separately reviewed change. It is
the only package permitted not to inherit the workspace `unsafe_code = "forbid"`
lint; all other members retain it. The exception must be explicit in that
crate's manifest and CI, with `unsafe_op_in_unsafe_fn = "deny"`, narrow private
unsafe blocks, and no mapping or policy logic. This is an isolation exception,
not a workspace-wide lint relaxation.

Its safe API owns handles with `Drop`, keeps window-procedure state pinned for
the HWND lifetime, validates pointer/length pairs before slices, models nullable
handles and Win32 errors explicitly, bounds all OS-sized allocations, prevents
use after device removal, and makes registration/unregistration and
notification tokens RAII guards. The callback catches unwinding before crossing
the ABI boundary and communicates through bounded typed records. Every unsafe
block states its Win32 preconditions and how they are upheld. Review requires:

- API-specific tests for zero/short/changing buffer sizes and invalid handles;
- architecture tests on x64 and ARM64 for layout, alignment, and pointer width;
- fuzzing of copied Raw Input byte buffers through the safe parser;
- Miri/tests for the pure parsing layer where applicable;
- dependency and symbol audit proving the boundary imports only documented
  Windows APIs; and
- a two-reviewer checklist for every unsafe change.

The FFI boundary must not expose raw pointers, borrowed callback memory, HWNDs,
token handles, or unvalidated unions to safe callers. Suppression technology has
its own separately audited boundary and is not added merely to complete Raw
Input.

## Required telemetry and diagnostics posture

There is no telemetry or network transport. Local diagnostics are opt-in,
size-bounded, and redact device paths, user paths, window titles, raw input,
mapped controls, process command lines, and SIDs. Allowed fields are component
version, Windows build, architecture, coarse device class/count, state
transition, integrity comparison result, queue watermark bucket, elapsed
duration, and stable error code. Debug builds must follow the same raw-input
logging prohibition.

## Test matrix and acceptance criteria

Each row is exercised with suppression unavailable and, once a suppression
candidate is separately approved, with suppression available. Every failure
case asserts: activation generation invalidated, old queue drained/discarded,
complete neutral requested, suppression released within its lease, and no
automatic reactivation.

| Area | Cases | Required result |
| --- | --- | --- |
| OS/architecture | Supported Windows 10 and 11 builds; x64 and ARM64 | Identical state semantics; wrapper layout tests pass; unsupported builds fail closed with explanation. |
| Basic Raw Input | One keyboard/mouse; press/release; wheel; horizontal wheel; extended keys; left/right modifiers | Ordered canonical transitions and relative deltas; no duplicate legacy processing; neutral on stop. |
| High-rate input | 125 Hz through 8 kHz mice; burst traffic; simultaneous key transitions; CPU contention | No unbounded allocation; deterministic coalescing; transitions retained; overload deactivates rather than dropping releases. |
| Packet robustness | Zero/short/changing size, unknown type, malformed union, extreme delta, API failure | No panic or out-of-bounds access; affected session becomes neutral and inactive. |
| Device identity | Identical models, composite devices, path case variants, unplug/replug, handle reuse, docking station | Ephemeral handles never inherit state; ambiguity blocks device-specific suppression; removal neutralizes. |
| Hotplug races | Removal with held key/button, arrival during enumeration, packet after removal, notification loss | New epoch reconciliation; stale packets discarded; explicit reactivation required. |
| Foreground | Target focus, Alt-Tab, minimize, close, hung window, transient zero HWND, launcher-to-child, PID reuse | Only exact selected instance is eligible; every loss/race neutralizes before later packets. |
| Executable identity | Same filename different directory, file replacement, symlink/reparse path, packaged app, query denied | Canonical instance check; ambiguity or unsupported identity fails closed. |
| Integrity | medium/medium, medium/high, high/medium test build, protected/query-denied target, different user/session | Mismatch/unknown clearly reported; no suppression or elevation retry; secure desktop never captured. |
| Mode ownership | xCloud active then local requested and reverse; concurrent requests | Neutralize-reset-activate transaction; never mixed sources or leases. |
| Mapping queue | Sequence gap, stale generation, saturation, full queue, emergency event during flood | Old/stale input has no effect; priority release is not starved; neutral on overload. |
| Suppression consent | Not installed, unsupported, declined, capability loss, per-device ambiguity | Mapping remains usable; physical input remains unsuppressed; no silent fallback to broader suppression. |
| Suppression lifecycle | Acquire/renew/release, target focus loss/exit, IPC EOF, helper fault, companion kill, forced termination | Fail-open within lease; output neutral/destroyed; enabled state absent after restart. |
| Emergency release | Chord before/during activation, held two seconds, early release, auto-repeat, injected chord, input flood | Physical chord always passes and releases; injected/repeated events cannot trigger; acknowledgement required. |
| Accessibility | Sticky/Filter/Toggle Keys enabled, Narrator, screen reader, high contrast, keyboard-only UI, compact/Fn keyboard, excluded assistive device | Settings remain unchanged; UI is operable; onboarding blocks suppression if chord cannot be proven. |
| Desktop/session | Lock/unlock, UAC secure desktop, screen saver, fast user switch, logoff, RDP connect/disconnect, second session | Immediate deactivation/release; no cross-session input; return only arms and requires consent again. |
| Power | Sleep, hibernate, Modern Standby, display-off notification, resume with devices changed, clock discontinuity | Pre-suspend release; fresh device epoch and target checks; no automatic reactivation. |
| Crash recovery | Panic on each thread, process kill, backend error, neutral publish failure, restart after crash | Independent leases fail open; destroy on failed neutral; restart begins inactive and reconciles safely. |
| Shutdown/update | Normal exit, OS shutdown, installer update/rollback/uninstall interrupted at each phase | Best-effort neutral plus independent expiry; no persisted suppression, orphaned registration, or active lease. |
| Privacy | Normal/debug logs, crash dumps, diagnostics export, error paths | No raw input, device path, window title, command line, SID, or mapping contents recorded/transmitted. |
| Policy/non-goals | Binary/import inspection and runtime observation | No DLL injection, game modification, anti-cheat bypass, network endpoint, macro/turbo, or chosen production driver. |

### Release gates

Local mapping may ship only after the Raw Input, foreground, lifecycle, privacy,
and unsafe-boundary rows pass on every supported architecture. Suppression has a
separate release gate and remains absent/off until a concrete implementation
passes every suppression, emergency, accessibility, crash, signing, servicing,
policy, install, rollback, and uninstall case. A test failure cannot be waived
by documenting that reboot restores input.
