. './lib.ps1'
Write-Output '=== health x2 (10s apart) ==='
$h1 = (Invoke-WebRequest -Uri 'http://127.0.0.1:8746/v1/health' -UseBasicParsing -TimeoutSec 3).Content
Write-Output $h1
Start-Sleep -Seconds 10
$h2 = (Invoke-WebRequest -Uri 'http://127.0.0.1:8746/v1/health' -UseBasicParsing -TimeoutSec 3).Content
Write-Output $h2
Write-Output '=== DevHub windows (final) ==='
Get-DevHubWindows | Format-Table Hwnd, Pid, X, Y, W, H, Title -AutoSize | Out-String -Width 200
Write-Output '=== processes ==='
Get-CimInstance Win32_Process -Filter "Name='DevHub.exe'" | Measure-Object | ForEach-Object { Write-Output ("DevHub.exe process count: " + $_.Count) }
