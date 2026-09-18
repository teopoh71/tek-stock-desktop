$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$maintenanceRoot = Join-Path $env:APPDATA 'TEK-STOCK-maintenance'
$protectedToken = Join-Path $maintenanceRoot 'monitor-token.dpapi'
$cursorFile = Join-Path $maintenanceRoot 'incident-cursor.json'
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($protectedToken), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$monitorToken = [Text.Encoding]::UTF8.GetString($plainBytes)
$result = Invoke-RestMethod -Uri 'https://tek-stock-maintenance.teopoh72.workers.dev/v1/incidents' -Headers @{Authorization=('Bearer ' + $monitorToken)} -TimeoutSec 20
if ($null -eq $result.incidents) { throw 'Incident response invalid' }
$seen = @{}
if (Test-Path -LiteralPath $cursorFile) {
  $previous = Get-Content -LiteralPath $cursorFile -Raw | ConvertFrom-Json
  foreach ($item in $previous) { $seen[$item] = $true }
}
$newIncidents = @()
foreach ($incident in $result.incidents) {
  $key = $incident.app_version + '|' + $incident.stage + '|' + $incident.error_code
  if (-not $seen.ContainsKey($key)) { $newIncidents += $incident; $seen[$key] = $true }
}
$temp = $cursorFile + '.tmp'
[IO.File]::WriteAllText($temp, (ConvertTo-Json -InputObject @($seen.Keys | Select-Object -Last 500)), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temp -Destination $cursorFile -Force
[pscustomobject]@{ok=$true;checkedAt=$result.checkedAt;newIncidents=$newIncidents;totalGroups=@($result.incidents).Count} | ConvertTo-Json -Depth 6 -Compress
