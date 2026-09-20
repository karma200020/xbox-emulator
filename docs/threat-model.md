# Threat Model

## Scope and security objectives

This model covers the Chrome Manifest V3 xCloud extension, its Native Messaging
connection, the Rust Windows companion, Raw Input local mode, optional input
suppression, the deterministic mapping core, packaging, and updates.

Security objectives are:

1. controller output occurs only after explicit user activation;
2. output returns to neutral on every error, timeout, focus loss, disconnect,
   shutdown, and mode transition;
3. only the approved extension and xCloud origins can drive xCloud mode;
4. untrusted browser, configuration, and device input cannot corrupt memory,
   gain privilege, or escape protocol bounds;
5. optional suppression cannot permanently lock out physical controls;
6. releases contain no macros, turbo, networking, or telemetry; and
7. users can verify the publisher and integrity of every installed component.

The model does not claim to protect a machine already controlled by an
administrator or kernel-mode attacker, or to make virtual controllers accepted
by every game or anti-cheat system.

## Assets

- User control of keyboard and mouse, including the ability to deactivate.
- Integrity and neutrality of emitted controller state.
- Activation, focus, mode, lease, and mapping configuration state.
- Native Messaging host registration and allowed-extension identity.
- Companion executable, extension package, driver/backend, installer, and
  update metadata.
- User account and filesystem permissions used by the companion.
- Availability of normal input and the target game session.
- Privacy of local input events and mapping configuration.
- Release signing keys and build provenance.

No gameplay, keystroke, account, or device telemetry is an intended asset
stored by a service because the product has no telemetry or network service.
Raw input remains sensitive transient data and must not be logged.

## Trust boundaries

### Web page to extension

The xCloud page, its frames, and all page JavaScript are untrusted. Content
scripts execute in an isolated world, accept no commands from page DOM events
or `postMessage`, and capture input only after checking the top-level allowed
origin, focus, and explicit activation.

### Extension to Native Messaging host

Native Messaging crosses from Chrome's extension sandbox into a native process.
All frames are untrusted even when Chrome launched the host. The host verifies
the allowed extension origin supplied by Chrome, negotiates protocol versions,
parses with strict limits, and applies semantic validation.

### Companion to Windows input and controller backend

Raw Input device data, device arrival/removal events, backend return values, and
driver behavior are untrusted. A controller driver may execute with greater
privilege than the companion and therefore has a substantially larger blast
radius. The adapter is a containment boundary.

### Standard user to elevated suppression

Input suppression may require elevated hooks, a helper, or a driver. Requests
from the normal companion to any elevated component are untrusted and must be
minimal, authenticated to the local installation, and limited to enable,
disable, health, and emergency release operations.

### Build and release boundary

Source, dependencies, CI workers, artifact storage, browser-store submission,
installer distribution, signing systems, and update channels cross separate
trust domains. A compromise here can replace all runtime protections.

## Entry points and abuse cases

| Abuse case | Consequence | Required mitigations |
| --- | --- | --- |
| A malicious site tries to invoke capture or Native Messaging. | Unauthorized controller control or input observation. | Exact xCloud host permissions; top-level origin and frame checks; no externally connectable extension API; exact extension ID allowlist in host manifest; reject unexpected launch origin. |
| Compromised xCloud page script interferes with browser mode. | Page-local virtual-controller manipulation or denial of service. | Extension-owned activation UI; isolated input capture; a private transferred `MessageChannel`; strict bounded command validation; the MAIN-world bridge has no extension APIs and cannot reach Native Messaging. The page is already the consumer of the virtual gamepad and remains outside the trusted extension context. |
| A malicious local process writes directly to the host executable's stdin or launches it. | Synthetic controller output. | Do not treat process launch as authorization; validate Native Messaging launch origin/channel where available; keep host path and manifest non-writable by unprivileged peers; fail closed when provenance cannot be established. |
| Oversized, deeply nested, malformed, or high-rate protocol messages are sent. | Memory exhaustion, CPU denial of service, panic, or parser exploit. | Native Messaging frame cap below Chrome's limit; bounded JSON depth/collections/strings; finite numeric checks; rate limits; strict enums; checked arithmetic; fuzz parser and state machine; neutralize before closing. |
| Old, duplicated, reordered, or cross-session input is replayed. | Stuck or attacker-selected controls. | Random per-process session ID, monotonically increasing sequence, activation lease ID, short lease expiry, reject duplicates/out-of-order frames, reset sequence on a fresh handshake. |
| Chrome service worker suspends, tab closes, or the pipe is severed while a button is held. | Latched controller input. | Companion-owned watchdog independent of browser cleanup; EOF handling; full-state snapshots; neutralize then destroy on timeout or disconnect. |
| Focus changes or navigation races with an input event. | Input reaches the wrong page or game. | Browser and companion focus/eligibility gates; serialize lifecycle and input messages; deactivate takes precedence; lease renewal only from the active eligible tab. |
| Two tabs or xCloud and local mode compete for control. | Mixed or unpredictable output. | Single-owner lease; modes mutually exclusive; neutralize-reset-activate transaction; reject input from non-owner sessions. |
| Crafted mappings request NaN, overflow, invalid keys, or hidden automation. | Unsafe output, crash, macro/turbo behavior. | Versioned schema; bounded values; finite floats; canonical key identifiers; checked fixed rules; reject delays, sequences, repeat rates, scripts, and multi-step actions; atomic configuration apply. |
| Extremely large mouse deltas or device-event floods occur. | Axis saturation or denial of service. | Saturating arithmetic, bounded queues, coalescing with documented deterministic rules, per-tick processing caps, drop-to-neutral on sustained overload. |
| A device is unplugged while input is active. | Held input remains latched. | Track device lifecycle; reset held state and publish neutral on removal or ambiguous identity change. |
| Controller backend fails after a partial update. | Inconsistent or stuck controller. | Publish complete snapshots only; serialize adapter calls; on any error send neutral and destroy; backend health check and process-death cleanup. |
| A vulnerable or malicious virtual-controller driver is installed. | Kernel compromise or system instability. | Production driver selection deferred; require maintained vendor, compatible license, signed package, supported Windows versions, security history review, minimal install footprint, and uninstall/rollback testing. |
| Suppression is enabled unintentionally or cannot be disabled. | Keyboard/mouse lockout. | Separate explicit consent each session; off by default; persistent visible indicator; unsuppressible emergency chord; watchdog; target/focus binding; auto-release on process exit and reboot; never suppress secure attention sequence. |
| An unelevated process commands an elevated suppression helper. | System-wide input denial. | Per-install authenticated local IPC, restrictive ACLs, no network endpoint, narrow command schema, caller/session checks, rate limits, and independent helper watchdog. |
| Input events or configuration are logged or transmitted. | Privacy breach, possible credential exposure. | No telemetry or network code; never log raw keys, mouse data, page content, or mappings; diagnostics opt-in, redacted, bounded, and local; dependency review for hidden reporting. |
| Extension or companion update is replaced or downgraded. | Arbitrary code execution or weakened protections. | Store/platform signing, Authenticode, signed update metadata, TLS through official stores, monotonic security version, rollback protection with a documented emergency process, and hash/provenance publication. |
| Build dependency or CI is compromised. | Backdoored release. | Lock dependencies, minimize them, audit Rust crates and extension packages, protected reviews, ephemeral least-privilege CI, isolated signing, reproducible-build checks where feasible, SBOM, and artifact attestations. |
| Another local user modifies manifests, binaries, or mappings. | Unauthorized execution or remapping. | Install binaries and host manifests under administrator-protected ACLs; store user configuration under that user's ACL; reject symlinks/reparse-point substitutions during privileged install/update. |
| Companion crashes or panics. | Stuck output or suppression. | Panic containment around event processing, top-level cleanup, backend process-death semantics, suppression watchdog, crash-safe neutral default, and no automatic reactivation after restart. |

## Security controls

### Activation and neutral-state invariant

The companion is the authority for active state. Activation requires an
eligible mode, a compatible handshake, a valid configuration, healthy input
and output backends, and an explicit user action. Browser input messages cannot
create or extend a lease before that action.

Neutral is a complete snapshot: all buttons released, triggers at zero, and
sticks centered. Neutralization is idempotent and has priority over queued
input. After any failure, the system remains inactive until a new explicit
activation. If neutral publication fails, the virtual device is destroyed.

### Protocol hardening

- Independently version protocol envelopes and mapping schemas.
- Reject incompatible major versions and unadvertised minor capabilities.
- Cap frame length, nesting, collection counts, string lengths, and event rate.
- Reject unknown fields in security-sensitive messages and unknown message
  types.
- Require finite, bounded numeric values and canonical identifiers.
- Bind input to session ID, sequence number, mode, and activation lease.
- Use bounded queues; never allow stale events to survive neutralization.
- Fuzz decoding, version negotiation, sequence handling, and lifecycle races.

Protocol versioning provides compatibility, not cryptographic authentication.
Authorization comes from Chrome's Native Messaging allowlist, protected local
installation, process/channel checks, and explicit activation.

### Least privilege

The browser-only extension requests only `activeTab`, storage needed for local
settings, and exact xCloud host access. It has no Native Messaging,
arbitrary-site, download, clipboard, debugger, or externally-connectable
permission. A future companion-enabled development build must add
`nativeMessaging` explicitly.

The companion runs as the interactive user. Elevation is never used for
mapping or virtual-controller publication unless the selected production
backend strictly requires it. Suppression is isolated so its elevated surface
can remain disabled and absent for users who do not install that feature.
There are no listening sockets, remote APIs, telemetry endpoints, or dynamic
code/plugin loaders.

### Privacy

Raw keystrokes and mouse motion are processed in memory and discarded after
state calculation. They are not persisted, transmitted, included in crash
dumps intentionally, or written to diagnostic logs. Status reporting uses
coarse states and error codes, never input payloads. Configuration export is a
deliberate local user action.

## Residual risks

- Malware running as the same user may synthesize input, inspect process
  memory, or interfere with the companion; administrator or kernel malware can
  fully bypass these controls.
- Any virtual-controller or suppression driver adds privileged attack surface,
  and vendor signing does not prove absence of vulnerabilities.
- OS scheduling stalls may delay neutralization until the watchdog or driver
  cleanup executes; zero-latency fail-safe behavior cannot be guaranteed.
- Games, xCloud, browser behavior, anti-cheat policy, and Windows APIs may
  change, causing incompatibility or account/policy consequences.
- An emergency suppression chord may conflict with accessibility needs or fail
  under severe OS/driver failure; reboot remains the final recovery path.
- Browser origin checks cannot make compromised Chrome or a maliciously
  replaced extension trustworthy.
- No telemetry reduces privacy risk but also limits detection of widespread
  exploitation; security reporting and update channels must compensate.
- Deterministic mapping does not prevent users from choosing mappings that are
  uncomfortable or disruptive, only from defining timed automation.

## Secure release constraints

A production release must not ship unless all of the following hold:

1. **Driver decision:** the controller backend has completed security,
   licensing, maintenance, compatibility, signing, uninstall, and crash-cleanup
   review. Until then, production driver selection remains deferred.
2. **Signed artifacts:** the extension is distributed through the approved
   browser store and native binaries/installers are Authenticode-signed.
   Signing keys are hardware-backed or held by an isolated signing service with
   audited access and rotation/revocation procedures.
3. **Reproducible inputs:** Rust and JavaScript dependencies are locked;
   releases use pinned toolchains and reviewed build definitions. An SBOM,
   checksums, provenance attestations, and source revision accompany artifacts.
4. **Protected pipeline:** releases require review by at least two authorized
   maintainers, protected tags, least-privilege ephemeral CI credentials, and
   separation between build and signing authority.
5. **Security gates:** tests cover neutralization for every lifecycle edge,
   watchdog expiry, focus/navigation races, device removal, parser fuzzing,
   sequence replay, malformed configurations, backend failure, and suppression
   emergency release. Static analysis and dependency vulnerability review pass.
6. **Permission audit:** extension permissions, allowed origins, Native
   Messaging extension IDs, filesystem ACLs, and any elevated IPC ACLs exactly
   match the documented minimum.
7. **Feature audit:** release artifacts contain no macro/turbo engine, network
   listener/client, telemetry SDK, remote code loading, or arbitrary-origin
   browser injection. Binary/dependency inspection verifies the source review.
8. **Update safety:** update metadata is authenticated, downgrade handling is
   documented, vulnerable versions can be revoked, and rollback preserves the
   ability to deactivate and uninstall safely.
9. **Recovery:** uninstall removes host registration, virtual devices, and
   optional suppression components; crash, upgrade, rollback, and uninstall
   tests confirm physical input is restored and controller state is neutral.
10. **Disclosure:** publish supported platforms, privacy behavior, known
    limitations, responsible-disclosure contact, security support lifetime,
    driver identity, and a clear statement that users must follow platform and
    game policies.

Any exception to these constraints requires a documented threat review,
explicit approval, an expiry date, and a fail-closed mitigation. No exception
may weaken explicit activation, neutral-on-failure behavior, or the prohibition
on macros, turbo, networking, and telemetry.
