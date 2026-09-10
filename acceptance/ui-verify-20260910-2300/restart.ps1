# restart.ps1 — L-batch resident restart flow: taskkill all DevHub.exe -> Start-Process (optional CDP port) -> wait health 200.
# Usage: powershell -File restart.ps1 [-DebugPort 9222]
param([int]$DebugPort = 0)
$ErrorActionPreference = 'Stop'
$exe = 'F:\Active_Project\DevHub\dist\win-unpacked\DevHub.exe'
$healthUrl = 'http://127.0.0.1:8746/v1/health'

Write-Output ("[{0}] killing DevHub.exe ..." -f (Get-Date -Format 'HH:mm:ss'))
taskkill /F /IM DevHub.exe /T 2>&1 | Out-Null
$deadline = (Get-Date).AddSeconds(20)
do {
  Start-Sleep -Milliseconds 500
  $left = @(Get-Process -Name DevHub -ErrorAction SilentlyContinue)
} while ($left.Count -gt 0 -and (Get-Date) -lt $deadline)
Write-Output ("[{0}] processes after kill: {1}" -f (Get-Date -Format 'HH:mm:ss'), $left.Count)
if ($left.Count -gt 0) { Write-Output 'RESULT: KILL-FAILED'; exit 2 }

if ($DebugPort -gt 0) {
  Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$DebugPort"
} else {
  Start-Process -FilePath $exe
}
Write-Output ("[{0}] started DevHub.exe (debugPort={1})" -f (Get-Date -Format 'HH:mm:ss'), $DebugPort)

$deadline = (Get-Date).AddSeconds(60)
$ok = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 1000
  try {
    $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
if (-not $ok) { Write-Output 'RESULT: HEALTH-TIMEOUT'; exit 3 }
Write-Output ("[{0}] health: {1}" -f (Get-Date -Format 'HH:mm:ss'), $r.Content)
$pids = @(Get-CimInstance Win32_Process -Filter "Name='DevHub.exe'" | Select-Object ProcessId, ParentProcessId)
Write-Output ("processes now: {0}" -f ($pids | ForEach-Object { $_.ProcessId }) -join ',')
Write-Output 'RESULT: RESTART-OK'
