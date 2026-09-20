# Signed Windows virtual Xbox-controller backend candidates

**Evidence cut-off:** 2026-09-20.  
**Scope:** research only. This document does not select a backend and does not
authorize integration.

## Safety and evaluation rule

Only a Microsoft-in-box facility or a vendor-published, production-signed
kernel package is admissible. An unsigned, self-signed, or test-signed driver
is an automatic **FAIL** for distribution. Microsoft's current signing
requirements say Hardware Dev Center submissions require a certificate and
attestation/WHCP submission requires an EV certificate associated with the
Partner Center account [MS-SIGN]. A sample or source repository is therefore
not a deployable driver.

The desired backend must also create an Xbox-compatible controller for other
Windows applications, support x64 and ARM64, have integration and
redistribution terms, remain maintained, remove virtual devices after an
unclean client exit, uninstall cleanly, and have an explicit anti-cheat
position. “No evidence found” is **UNKNOWN**, not an implied pass.

## Pass/fail/unknown matrix

Legend: **P** = authoritative evidence passes the stated criterion; **F** =
authoritative evidence fails it; **U** = not established by the cited
authoritative material. “Overall” is only a research gate, not a selection.

| Candidate | Production signing / no third-party driver | Xbox-visible output | x64 | ARM64 | Integration / redistribution license | Maintained | Process-death cleanup | Clean uninstall | Anti-cheat position | Overall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Microsoft `InputInjector.InitializeGamepadInjection` | P | U | U | U | U | P | U | P | U | **U** |
| Nefarius VirtualPad Framework | U | P | U | U | U | U | U | P | U | **U** |
| ViGEmBus + ViGEmClient 1.x | P | P | P | P | P | **F** | U | P | U | **F** |
| x360ce v4 / bundled ViGEmBus | P | P | P | P | U | F | **F** | U | F | **F** |
| Steam Input Gamepad Emulation | P | P | U | U | F | U | U | U | U | **F** |
| BrunnerInnovation vJoy | P | **F** | P | U | P | U | U | P | U | **F** |
| Custom Microsoft VHF source driver | **F** | U | U | U | U | U | U | U | U | **F** |

### 1. Microsoft input injection

Microsoft documents `InitializeGamepadInjection` as creating a virtual gamepad,
analogous to connecting a physical gamepad and raising `GamepadAdded`
[MS-INJECT]. Its matching `UninitializeGamepadInjection` disconnects the
device and raises `GamepadRemoved` [MS-UNINJECT]. It is an in-box Windows API,
so no third-party kernel driver is distributed or removed.

Important gaps remain:

- The API requires the restricted `inputInjectionBrokered` capability.
  Microsoft says Store submissions using restricted capabilities require
  approval, although sideloading does not [MS-CAP].
- The docs promise a Windows Gaming Input “gamepad,” but do not promise that
  arbitrary desktop applications see an Xbox 360/XInput device. That key
  compatibility requirement is therefore unknown.
- The API contract starts at Windows 10 version 1709, but the cited page gives
  no explicit x64/ARM64 guarantee.
- Explicit crash/process-termination semantics and anti-cheat acceptance were
  not found.

This is a concrete Microsoft API candidate, but it remains **UNKNOWN** until
capability eligibility and system-wide XInput behavior are proven on both
architectures.

### 2. Nefarius VirtualPad Framework

The vendor describes VirtualPad only as a **commercial framework for gaming
peripheral emulation available to business partners** [VP-ABOUT]. The public
changelog proves that runtime 2.48.0 can create a “virtual Xbox 360 device” and
that the framework had releases through 2.116.0 dated 2024-06-17 [VP-CHANGE].
The vendor also publishes an Installed Apps removal path for “Nefarius
VirtualPad Driver Runtime” [VP-REMOVE].

Public authoritative documentation does **not** establish production-signing
status, x64/ARM64 deliverables, SDK/redistribution terms, unexpected process
death cleanup, current support lifetime, or anti-cheat compatibility. Those
items require a written vendor proposal and binaries whose signatures can be
verified. Commercial availability is not itself a licensing pass.

### 3. ViGEmBus and ViGEmClient 1.x — retired

The official repositories explicitly say **“THIS PROJECT HAS BEEN RETIRED”**
for both ViGEmBus [VIGEM-BUS] and ViGEmClient [VIGEM-CLIENT]. This fact must
not be obscured by the continued availability of binaries.

Before retirement, the official bus repository documented:

- Xbox 360 emulation, Windows 10/11 x86/amd64/ARM64 builds, and
  vendor-provided production-signed release binaries [VIGEM-BUS];
- a BSD-3-Clause bus-driver license [VIGEM-LICENSE] and MIT client license
  [CLIENT-LICENSE];
- a normal uninstaller plus a documented full Driver Store cleanup procedure
  [VIGEM-REMOVE].

The client README documents orderly target removal and disconnect, but does
not guarantee cleanup when the feeder process is killed [VIGEM-CLIENT].
Anti-cheat support is undocumented. Retirement makes this candidate an
unambiguous maintenance **FAIL**, regardless of its prior technical fit.

### 4. x360ce v4

The current official README says v4 emulates an Xbox 360 controller and that
signed builds include Virtual Gamepad Emulation Bus 1.21.442.0 on Windows 10+
[X360CE]. That bus is the retired ViGEmBus line above, so ongoing application
activity does not cure backend retirement.

The same README explicitly warns that killing or crashing x360ce can leave the
virtual controller behind, which is a process-death **FAIL**, and says Denuvo
protected games are unsupported [X360CE]. The repository provides a complete
application rather than a documented stable feeder SDK/redistribution
contract. It is therefore not an acceptable embedded backend candidate.

### 5. Steam Input Gamepad Emulation

Valve documents that, on Windows, the Steam Overlay hooks XInput, DirectInput,
RawInput, and Windows.Gaming.Input and injects an emulated Xbox controller
*into the game* [STEAM-INPUT]. This is useful provenance but fails the required
backend shape: it is Steam/game scoped, consumes a user's controller through
Steam, and is not an SDK for an emulator to publish arbitrary system-wide
controller state. The Steamworks SDK is for applications shipping through
Steam [STEAM-SDK]. Architecture, process-death, uninstall, redistribution,
and anti-cheat guarantees for this use were not found.

### 6. BrunnerInnovation vJoy

The maintainer states that it sponsored signing so newer Windows 11 platforms
could use vJoy, supports only Windows 10/11, and may sign important future
fixes but does **not** intend substantial maintenance [VJOY]. The repository
is MIT-licensed and includes a Driver Store removal procedure [VJOY].

vJoy is a virtual joystick, not an Xbox/XInput controller, and the build notes
only identify x86/x64 test targets; no authoritative ARM64 release statement
was found. It therefore fails the core output requirement even though an x64
signed release exists. Test-signing instructions in the repository are for
development only and are **not acceptable for distribution**.

### 7. A custom Virtual HID Framework driver is not a signed candidate

Microsoft's VHF is a supported way to write a kernel-mode HID source driver,
using the in-box `Vhf.sys`, but the product still supplies **its own**
kernel-mode source driver [MS-VHF]. Microsoft does not provide a ready-made,
production-signed virtual Xbox controller package. Such a driver would need
design, Xbox-compatibility validation, x64/ARM64 builds, lifecycle handling,
uninstall support, security review, and Microsoft production signing
[MS-SIGN]. It fails this survey's “concrete signed backend” gate. Test signing
is expressly not a shipping alternative.

## Evidence-driven conclusion

No candidate receives an overall pass:

- **Microsoft input injection** and **Nefarius VirtualPad** remain credible
  investigation leads, but each has blocking unknowns.
- **ViGEmBus/ViGEmClient are officially retired.**
- x360ce inherits that retired driver and documents stale devices on crashes.
- Steam Input is game/Steam scoped, vJoy is not Xbox-compatible, and VHF is
  only a build-and-sign route.

Before any later selection, obtain written VirtualPad architecture/signing/
license/lifecycle answers and separately prototype the Microsoft restricted
API to verify XInput visibility, capability approval, crash cleanup, and
anti-cheat behavior. This document makes no backend recommendation.

## Provenance

All URLs were checked on **2026-09-20**. Sources are official vendor
documentation, official repositories, or Microsoft/Valve documentation.

- **[MS-SIGN]** Microsoft, “Driver Code Signing Requirements,” updated
  2026-08-26:
  <https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-reqs>
- **[MS-INJECT]** Microsoft, `InputInjector.InitializeGamepadInjection`:
  <https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.preview.injection.inputinjector.initializegamepadinjection?view=winrt-26100>
- **[MS-UNINJECT]** Microsoft,
  `InputInjector.UninitializeGamepadInjection`:
  <https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.preview.injection.inputinjector.uninitializegamepadinjection?view=winrt-26100>
- **[MS-CAP]** Microsoft, “App capability declarations,” updated 2026-09-08:
  <https://learn.microsoft.com/en-us/windows/uwp/packaging/app-capability-declarations#restricted-capabilities>
- **[MS-VHF]** Microsoft, “Write a HID source driver by using Virtual HID
  Framework,” dated 2025-04-22:
  <https://learn.microsoft.com/en-us/windows-hardware/drivers/hid/virtual-hid-framework--vhf->
- **[VP-ABOUT]** Nefarius, “About Nefarius VirtualPad Framework”:
  <https://docs.nefarius.at/projects/VirtualPad/>
- **[VP-CHANGE]** Nefarius, VirtualPad Runtime changelog:
  <https://docs.nefarius.at/projects/VirtualPad/Runtime/Changelog/>
- **[VP-REMOVE]** Nefarius, “Why You Are Seeing This Update” / uninstall:
  <https://docs.nefarius.at/projects/VirtualPad/Runtime/Help/From2_201_0_To_1st_public_MSI/>
- **[VIGEM-BUS]** Nefarius, official retired ViGEmBus repository:
  <https://github.com/nefarius/ViGEmBus>
- **[VIGEM-CLIENT]** Nefarius, official retired ViGEmClient repository:
  <https://github.com/nefarius/ViGEmClient>
- **[VIGEM-LICENSE]** ViGEmBus BSD-3-Clause license:
  <https://github.com/nefarius/ViGEmBus/blob/master/LICENSE>
- **[CLIENT-LICENSE]** ViGEmClient MIT license:
  <https://github.com/nefarius/ViGEmClient/blob/master/LICENSE>
- **[VIGEM-REMOVE]** Nefarius, “How to Install/Remove”:
  <https://docs.nefarius.at/projects/ViGEm/How-to-Install/>
- **[X360CE]** x360ce official repository README:
  <https://github.com/x360ce/x360ce/blob/master/README.MD>
- **[STEAM-INPUT]** Valve, “Steam Input Gamepad Emulation - Best Practices”:
  <https://partner.steamgames.com/doc/features/steam_controller/steam_input_gamepad_emulation_bestpractices>
- **[STEAM-SDK]** Valve, Steamworks SDK:
  <https://partner.steamgames.com/doc/sdk>
- **[VJOY]** BrunnerInnovation official vJoy fork README:
  <https://github.com/BrunnerInnovation/vJoy>
