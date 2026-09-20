$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

npm run check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$manifest = Get-Content "apps\extension\manifest.json" -Raw | ConvertFrom-Json
$release = Join-Path $root "release"
$zip = Join-Path $release "xbox-input-bridge-$($manifest.version)-chrome.zip"
New-Item -ItemType Directory -Force -Path $release | Out-Null
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "apps\extension\dist\*" -DestinationPath $zip -CompressionLevel Optimal
Write-Output $zip
