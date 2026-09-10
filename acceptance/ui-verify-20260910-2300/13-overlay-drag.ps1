. './lib.ps1'
$win = Get-DevHubWindows | Where-Object { $_.X -gt 1000 -and $_.H -lt 200 } | Select-Object -First 1
if (-not $win) { Write-Output 'RESULT: OVERLAY-NOT-FOUND'; exit 2 }
$before = @{ X = $win.X; Y = $win.Y; W = $win.W; H = $win.H }
Write-Output ("before drag: {0},{1} {2}x{3}" -f $before.X, $before.Y, $before.W, $before.H)
# grab left part of collapsed bar (avoid 展开 button on the right)
$gx = $before.X + 120
$gy = $before.Y + [int]($before.H / 2)
Move-Mouse $gx $gy
Start-Sleep -Milliseconds 250
Invoke-MouseDown
Start-Sleep -Milliseconds 200
# drag: +170px x, +120px y in 12 steps
for ($i = 1; $i -le 12; $i++) {
  Move-Mouse ($gx + [int](170 * $i / 12)) ($gy + [int](120 * $i / 12))
  Start-Sleep -Milliseconds 40
}
Start-Sleep -Milliseconds 300
Invoke-MouseUp
Start-Sleep -Milliseconds 800
$after = Get-DevHubWindows | Where-Object { $_.X -gt 1000 -and $_.H -lt 200 } | Select-Object -First 1
Write-Output ("after drag:  {0},{1} {2}x{3}" -f $after.X, $after.Y, $after.W, $after.H)
$dx = $after.X - $before.X; $dy = $after.Y - $before.Y
Write-Output ("delta: dx={0} dy={1} (require magnitude>=50)" -f $dx, $dy)
$mag = [Math]::Sqrt($dx * $dx + $dy * $dy)
if ($mag -ge 50) { Write-Output ("RESULT: DRAG-OK mag={0:N0}" -f $mag) } else { Write-Output ("RESULT: DRAG-INSUFFICIENT mag={0:N0}" -f $mag); exit 3 }
