# Microsoft gamepad injection feasibility spike

Status: **non-shipping; runtime feasibility remains unverified** (2026-09-20).
Nothing in this spike is selected for production.

## Finding

`Windows.UI.Input.Preview.Injection.InputInjector.InitializeGamepadInjection`
is a documented Microsoft API introduced in Windows 10 1709 (build 16299).
It creates a virtual gamepad and raises `Windows.Gaming.Input.GamepadAdded`;
`UninitializeGamepadInjection` removes it and raises `GamepadRemoved`.

A packaged desktop (Win32, medium-integrity/full-trust) application can compile
the WinRT call and carry the required package identity/capabilities. Microsoft's
desktop WinRT guidance says most WinRT APIs are available to desktop apps and
does not list `InputInjector` as unsupported. However, Microsoft does not
explicitly document `InitializeGamepadInjection` as supported for a medium-IL
desktop process. This machine has neither Visual Studio/MSBuild nor a Windows
SDK, so compilation and the decisive `TryCreate`/initialize runtime call could
not be performed. **Actual invocation from packaged desktop is therefore
unknown, not claimed proven.**

There is a more important product limitation. Microsoft's current capability
reference says that, on PC, injected input from an app with
`inputInjectionBrokered` is received only by processes in the **same App
Container**. A medium-IL packaged desktop process is not an AppContainer, and
Edge/xCloud is not in this package's AppContainer. The docs do not clarify how
that statement maps to gamepad injection from medium IL. It also conflicts in
scope with the input-injection overview's broader statement that injection can
target outside the app, including elevated apps. Until the matrix below is run
or Microsoft clarifies the gamepad/desktop case, WGI visibility, XInput
visibility, and xCloud visibility must all be recorded as **unknown**. Do not
infer system-wide xCloud compatibility from a successful in-process WGI check.

## Capability and Store approval

The package must declare both:

```xml
<rescap:Capability Name="runFullTrust" />
<rescap:Capability Name="inputInjectionBrokered" />
```

`inputInjectionBrokered` is a **restricted capability**. `runFullTrust`, needed
for this full-trust desktop package, is restricted as well. For Store
distribution, Partner Center detects it and requires a detailed explanation on
Submission options for each declared restricted capability; Microsoft reviews
and must approve the use during
certification. Rejection fails certification. For a Partner Center development
sandbox (including Xbox Live games), approval must be requested in advance
through the Microsoft account team; Microsoft says this generally takes five
business days or longer. Sideloading a restricted-capability package does not
require Store approval. Approval is not guaranteed.

The source and manifest are isolated in
`spikes/microsoft-gamepad-injection/`. They add no driver, service, production
manifest entry, installer action, workspace member, or backend choice.

## Build and registration

Exact prerequisites:

1. Windows 10 1709+ (x64) or Windows 11 ARM64 for native ARM64 execution.
2. Visual Studio 2022 with Desktop development with C++, MSVC v143, and a
   Windows 10/11 SDK.
3. NuGet connectivity for `Microsoft.Windows.CppWinRT` 2.0.240405.15.
4. Developer Mode for `Add-AppxPackage -Register`, or sign the generated MSIX
   with a certificate trusted by the test machine. This is package signing,
   not driver signing.

From the spike directory:

```powershell
.\Build.ps1 -Platform x64
Add-AppxPackage -Register .\out\x64\layout\AppxManifest.xml
.\out\x64\layout\MicrosoftGamepadInjectionSpike.exe inject
```

For ARM64, replace `x64` with `ARM64`. `-Pack` additionally creates an unsigned
MSIX for validation; it is not directly installable until appropriately
signed. Do not install or create any test-signed/unsigned driver.

### Validation completed in this environment

- `Build.ps1` passed the PowerShell parser.
- The VCX project and both x64/ARM64-expanded manifest XML are well formed.
- Searches found no spike/capability reference in `Cargo.toml`, `apps/`,
  `crates/`, or `installer/`.
- The build was attempted and stopped deterministically because
  `vswhere.exe`/Visual Studio 2022 is absent. The installed .NET SDK is 2.2,
  no MSBuild is on `PATH`, and no usable Windows SDK include tree is present.
  Consequently no compile, package-schema validation, registration, or runtime
  result is claimed.

## Reproducible manual test matrix

Run each row on clean x64 and native ARM64 machines. Disconnect physical
controllers first. Record OS build, architecture, package full name, HRESULT,
and pass/fail/unknown—do not convert missing evidence into a claim.

1. **Baseline:** Copy the built EXE outside the package layout and run
   `MicrosoftGamepadInjectionSpike.exe probe`. Confirm `WGI gamepads=0` and
   `XInput slots=none`. Also open the xCloud controller-detection screen and
   confirm no controller. Keep the external probe running.
2. **Packaged invocation:** Run the copy inside the registered layout with
   `inject`. A valid result prints “Virtual gamepad initialized” and toggles A
   once per second. `TryCreate` returning null or an HRESULT is a failed result
   to preserve verbatim.
3. **WGI visibility:** Record the injector's WGI count and the external
   probe's WGI count. Optionally use a second known WGI test application.
   Verify `GamepadAdded`, alternating A readings, then `GamepadRemoved`.
4. **XInput visibility:** In the external probe, record whether any of slots
   0–3 appears and whether A alternates. An absent XInput slot is a valid
   negative result; WGI visibility does not imply XInput visibility.
5. **Graceful cleanup:** Press Escape in `inject`; verify WGI removal and all
   newly occupied XInput slots disappear within five seconds.
6. **Process-kill cleanup:** Start `inject` again, then use Task Manager
   **End task** on that exact PID (or `Stop-Process -Id <PID>`). Verify WGI and
   XInput removal within five seconds. Reboot before continuing if a device
   remains, and record the failure.
7. **xCloud:** With injection active, focus the official Xbox Cloud Gaming web
   client. Record whether it detects a controller and receives alternating A.
   Repeat with browser focus before and after initialization. Do not use any
   anti-cheat bypass or attempt to mask the virtual source. Based on the
   same-AppContainer restriction, the conservative expectation is **not
   detected**, but only the observed result closes this row.
8. **Architecture:** Repeat 1–7 with native x64 and ARM64 builds. Do not treat
   x64 emulation on ARM64 as the ARM64 result.
9. **Uninstall:** Exit/kill all spike processes, then run:

   ```powershell
   Get-AppxPackage Microsoft.GamepadInjectionSpike | Remove-AppxPackage
   Get-AppxPackage Microsoft.GamepadInjectionSpike
   ```

   The second command must return nothing. Re-run both external WGI and XInput
   probes (from a separately retained executable) and confirm no spike device.
   Delete `spikes\microsoft-gamepad-injection\out` and `bin` if desired.

## Decision gate

Do not promote this approach unless Microsoft confirms medium-IL packaged
desktop support, Store restricted-capability approval is obtained for the
actual product scenario, and all x64/ARM64 rows pass—especially external
XInput and xCloud. The documented same-AppContainer boundary currently makes
this a poor candidate for controlling an unrelated browser/xCloud process.

## Authoritative references

- [InitializeGamepadInjection](https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.preview.injection.inputinjector.initializegamepadinjection)
- [TryCreate](https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.preview.injection.inputinjector.trycreate)
- [InjectGamepadInput](https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.preview.injection.inputinjector.injectgamepadinput)
- [UninitializeGamepadInjection](https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.preview.injection.inputinjector.uninitializegamepadinjection)
- [Input injection setup](https://learn.microsoft.com/en-us/windows/uwp/ui-input/input-injection)
- [App capabilities and restricted-capability approval](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)
- [WinRT APIs not supported in desktop apps](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/winrt-api-desktop-app-support)
- [Gamepad (Windows.Gaming.Input)](https://learn.microsoft.com/en-us/uwp/api/windows.gaming.input.gamepad)
- [XInputGetState](https://learn.microsoft.com/en-us/windows/win32/api/xinput/nf-xinput-xinputgetstate)
