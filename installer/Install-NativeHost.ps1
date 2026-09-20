[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string] $ExtensionId,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $CompanionPath
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.xib.companion'
$installDirectory = Join-Path $env:LOCALAPPDATA 'XboxInputBridge'
$manifestPath = Join-Path $installDirectory "$hostName.json"
$originPath = Join-Path $installDirectory 'allowed-origin.txt'
$resolvedCompanionPath = (Resolve-Path -LiteralPath $CompanionPath).Path

New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null

$manifest = [ordered]@{
    name = $hostName
    description = 'Xbox Input Bridge native companion'
    path = $resolvedCompanionPath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}

$json = $manifest | ConvertTo-Json -Depth 3
$temporaryPath = "$manifestPath.tmp"
[IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryPath -Destination $manifestPath -Force
[IO.File]::WriteAllText(
    $originPath,
    "chrome-extension://$ExtensionId/",
    [Text.UTF8Encoding]::new($false)
)

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

Write-Output "Registered $hostName for extension $ExtensionId."
Write-Output "Manifest: $manifestPath"
