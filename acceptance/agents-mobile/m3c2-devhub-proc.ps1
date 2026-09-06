# M3-C2 helper: show DevHub main process command line (check debug port stripped)
$procs = Get-CimInstance Win32_Process -Filter "Name='DevHub.exe'"
$main = $procs | Where-Object { $null -ne $_.CommandLine -and $argv -eq $null }
foreach ($p in $procs) {
  if ($p.CommandLine -notmatch '--type=') {
    Write-Output ("MAIN pid=" + $p.ProcessId)
    Write-Output ("CMD=" + $p.CommandLine)
    if ($p.CommandLine -match 'remote-debugging-port') { Write-Output 'DEBUGPORT=present' } else { Write-Output 'DEBUGPORT=stripped' }
  }
}
