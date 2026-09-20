[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$hostName = 'com.xib.companion'
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$manifestPath = Join-Path $env:LOCALAPPDATA "XboxInputBridge\$hostName.json"
$originPath = Join-Path $env:LOCALAPPDATA 'XboxInputBridge\allowed-origin.txt'

if (Test-Path -LiteralPath $registryPath) {
    Remove-Item -LiteralPath $registryPath -Force
}
if (Test-Path -LiteralPath $manifestPath) {
    Remove-Item -LiteralPath $manifestPath -Force
}
if (Test-Path -LiteralPath $originPath) {
    Remove-Item -LiteralPath $originPath -Force
}

Write-Output "Removed $hostName registration."
