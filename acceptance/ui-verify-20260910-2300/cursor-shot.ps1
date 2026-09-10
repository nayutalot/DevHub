. (Join-Path $PSScriptRoot 'lib.ps1')
$p = New-Object MLib+RECT
[MLib]::GetCursorPos([ref]$p) | Out-Null
$cx = $p.L; $cy = $p.T
Write-Output "cursor at $cx,$cy"
$x = [Math]::Max(0, $cx - 40); $y = [Math]::Max(0, $cy - 20)
Save-RegionShot $x $y 600 360 (Join-Path $PSScriptRoot '22-menu-at-cursor.png')
$fg = [MLib]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[MLib]::GetClassNameW($fg, $sb, 256) | Out-Null
Write-Output ("foreground class=[" + $sb.ToString() + "]")
