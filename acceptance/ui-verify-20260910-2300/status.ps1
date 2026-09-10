param()
$ErrorActionPreference = 'SilentlyContinue'
Write-Output '=== DevHub processes ==='
Get-CimInstance Win32_Process -Filter "Name='DevHub.exe' OR Name='electron.exe'" | Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine | Format-List | Out-String -Width 300
Write-Output '=== CDP 9222 ==='
try { (Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/list' -UseBasicParsing -TimeoutSec 3).Content } catch { Write-Output ("CDP fail: " + $_.Exception.Message) }
