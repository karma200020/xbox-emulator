# Microsoft gamepad injection feasibility spike

**Non-shipping experiment. Do not reference this directory from production
projects, installers, or manifests.**

This is a packaged Win32 console probe for
`InputInjector.InitializeGamepadInjection`. It intentionally uses only
Microsoft's inbox API: it installs no driver and contains no production
backend selection.

## Prerequisites

- Windows 10 1709 (10.0.16299) or newer.
- Visual Studio 2022 with **Desktop development with C++**, MSVC v143, and a
  Windows 10/11 SDK containing `makeappx.exe`.
- NuGet access for `Microsoft.Windows.CppWinRT`.
- Developer Mode for loose-package registration, or an appropriately trusted
  certificate for a packed MSIX.

From a Developer PowerShell:

```powershell
.\Build.ps1 -Platform x64
Add-AppxPackage -Register .\out\x64\layout\AppxManifest.xml
.\out\x64\layout\MicrosoftGamepadInjectionSpike.exe inject
```

Build ARM64 on an ARM64 test machine (or cross-compile on x64):

```powershell
.\Build.ps1 -Platform ARM64
```

Remove the loose package:

```powershell
Get-AppxPackage Microsoft.GamepadInjectionSpike |
  Remove-AppxPackage
```

See `docs/microsoft-gamepad-injection-spike.md` for the decision, limitations,
and complete test matrix.
