. (Join-Path $PSScriptRoot 'lib.ps1')
$fg = [MLib]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[MLib]::GetClassNameW($fg, $sb, 256) | Out-Null
$cn = $sb.ToString()
$sb2 = New-Object System.Text.StringBuilder 256
[MLib]::GetWindowTextW($fg, $sb2, 256) | Out-Null
$p = [uint32]0
[MLib]::GetWindowThreadProcessId($fg, [ref]$p) | Out-Null
$pn = (Get-Process -Id $p -ErrorAction SilentlyContinue).Name
$r = New-Object MLib+RECT
[MLib]::GetWindowRect($fg, [ref]$r) | Out-Null
Write-Output ("foreground: pid=$p proc=$pn class=[$cn] title=[$($sb2.ToString())] rect=$($r.L),$($r.T) $(($r.R - $r.L))x$(($r.B - $r.T))")
