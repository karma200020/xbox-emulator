# Virtual Controller Driver Evaluation

## Current decision

Production virtual-controller driver selection is deferred by product scope.
Version 1 uses only a fake backend for development and deterministic testing;
it does not install, bundle, or depend on a production virtual-controller
driver.

The official `nefarius/ViGEmBus` and `nefarius/ViGEmClient` repositories state
that the projects are retired. They must not be described as maintained.

## Why v1 uses a fake backend

The fake backend implements the controller adapter contract in user space. It
records complete controller snapshots and simulates creation, health failures,
neutralization, and destruction without exposing a controller to Windows or a
game. This allows the project to validate:

- deterministic keyboard/mouse mapping;
- mode and activation state transitions;
- protocol compatibility and malformed-input handling;
- watchdog, disconnect, and process-failure behavior; and
- the invariant that all failure paths request neutral state.

Using a fake backend avoids prematurely selecting or distributing privileged
software whose security, licensing, platform support, servicing, and policy
implications have not passed review. It is not a production controller solution
and must be clearly labeled as such.

## Production release gates

A production backend cannot be selected or shipped until evidence establishes
all of the following:

1. **Platform and architecture support:** supported, signed packages exist for
   the targeted Windows 10 and Windows 11 releases on both x64 and ARM64.
2. **Official provenance:** binaries, source where applicable, documentation,
   and updates come from an identifiable official publisher through an
   authenticated distribution channel.
3. **Licensing:** licenses permit the project's intended use, redistribution,
   packaging, and update model, including all client libraries and drivers.
4. **Servicing:** a responsible publisher provides a credible vulnerability
   response, security-update, compatibility, versioning, and end-of-life
   process.
5. **Process-death neutralization:** independent testing confirms that companion
   crashes, forced termination, IPC loss, and backend failure cannot leave
   latched buttons, triggers, or axes. The device must become neutral or be
   removed without relying solely on normal application cleanup.
6. **Uninstall and recovery:** install, upgrade, rollback, and uninstall restore
   a clean system without orphaned devices, services, packages, registrations,
   or input state. Recovery from interrupted operations is documented and
   tested.
7. **Anti-cheat and platform policy:** the backend's use is reviewed against
   applicable Xbox, game, anti-cheat, enterprise, and driver policies. The
   product must disclose that compatibility or acceptance cannot be guaranteed.

Passing technical tests alone is insufficient. Release also requires security,
legal, and product approval of the collected evidence.

## Category comparison

| Category | Potential fit | Evidence and concerns requiring evaluation |
| --- | --- | --- |
| Retired ViGEmBus and ViGEmClient | Their APIs and prior ecosystem may be useful reference material or support non-production investigation. | The official repositories state that the projects are retired, so they cannot satisfy a maintained-servicing requirement without a separately evaluated successor or responsible fork. Any license, binary provenance, signing, architecture support, process-death behavior, uninstall behavior, and policy compatibility must be verified rather than inferred from historical use. |
| Custom WHQL driver | Could provide direct control over lifecycle semantics and the adapter contract. | Requires specialized kernel engineering, Microsoft signing and certification, x64 and ARM64 support, secure installation and updating, long-term vulnerability response, extensive failure testing, and ongoing compatibility work. WHQL status alone would not establish security, policy acceptance, or maintainability. |
| Commercial maintained SDK | Could transfer some driver development, signing, compatibility, and servicing work to a vendor. | Claims must be confirmed through contracts, documentation, test artifacts, and independent validation. Licensing and redistribution terms, supported architectures, provenance, update commitments, offline behavior, process-death neutralization, uninstall quality, vendor longevity, privacy, and anti-cheat policy remain release gates. “Commercial” does not by itself imply suitability or maintenance quality. |

This comparison intentionally makes no claim that any category or unnamed
product currently passes the gates. Candidate-specific claims require dated,
reviewable evidence from authoritative sources and testing against the exact
artifacts proposed for release.

## Deferred decision

Driver procurement and production integration are outside the approved v1
scope. The controller adapter remains driver-neutral, and the fake backend is
the only v1 implementation. A later scoped decision may evaluate concrete
candidates against the gates above; until that review is approved, builds must
not silently download, install, bundle, or activate any virtual-controller
driver.
