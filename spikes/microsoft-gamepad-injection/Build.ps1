[CmdletBinding()]
param(
    [ValidateSet("x64", "ARM64")]
    [string] $Platform = "x64",
    [ValidateSet("Debug", "Release")]
    [string] $Configuration = "Release",
    [switch] $Pack
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    throw "Visual Studio 2022 is required (vswhere.exe was not found)."
}

$msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild `
    -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
if (-not $msbuild) {
    throw "MSBuild was not found. Install Visual Studio 2022 Desktop development with C++."
}

& $msbuild "$root\MicrosoftGamepadInjectionSpike.vcxproj" `
    /restore /m /p:Configuration=$Configuration /p:Platform=$Platform
if ($LASTEXITCODE -ne 0) {
    throw "MSBuild failed with exit code $LASTEXITCODE."
}

$out = Join-Path $root "out\$Platform"
$layout = Join-Path $out "layout"
Remove-Item $layout -Recurse -Force -ErrorAction SilentlyContinue
New-Item (Join-Path $layout "Assets") -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $root "bin\$Platform\$Configuration\MicrosoftGamepadInjectionSpike.exe") $layout

$architecture = $Platform.ToLowerInvariant()
$manifest = (Get-Content (Join-Path $root "AppxManifest.xml.in") -Raw).Replace("__ARCH__", $architecture)
Set-Content (Join-Path $layout "AppxManifest.xml") $manifest -Encoding UTF8

Add-Type -AssemblyName System.Drawing
@{
    "StoreLogo.png" = 50
    "Square44x44Logo.png" = 44
    "Square150x150Logo.png" = 150
}.GetEnumerator() | ForEach-Object {
    $bitmap = New-Object System.Drawing.Bitmap($_.Value, $_.Value)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::DarkSlateBlue)
        } finally {
            $graphics.Dispose()
        }
        $bitmap.Save(
            (Join-Path $layout "Assets\$($_.Key)"),
            [System.Drawing.Imaging.ImageFormat]::Png
        )
    } finally {
        $bitmap.Dispose()
    }
}

if ($Pack) {
    $kits = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
    $makeappx = Get-ChildItem $kits -Filter makeappx.exe -Recurse |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    if (-not $makeappx) {
        throw "makeappx.exe was not found. Install a Windows 10/11 SDK."
    }
    New-Item $out -ItemType Directory -Force | Out-Null
    & $makeappx pack /o /d $layout /p (Join-Path $out "MicrosoftGamepadInjectionSpike.msix")
    if ($LASTEXITCODE -ne 0) {
        throw "MakeAppx failed with exit code $LASTEXITCODE."
    }
}

Write-Host "Loose package: $layout"
Write-Host "Register for development: Add-AppxPackage -Register `"$layout\AppxManifest.xml`""
