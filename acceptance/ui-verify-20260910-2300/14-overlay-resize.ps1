. './lib.ps1'
$win = Get-DevHubWindows | Where-Object { $_.X -gt 1000 -and $_.H -lt 200 } | Select-Object -First 1
if (-not $win) { Write-Output 'RESULT: OVERLAY-NOT-FOUND'; exit 2 }
$before = @{ X = $win.X; Y = $win.Y; W = $win.W; H = $win.H }
Write-Output ("before resize: {0},{1} {2}x{3}" -f $before.X, $before.Y, $before.W, $before.H)
# grab LEFT edge (2px inside), drag left by -120px -> width grows
$gx = $before.X + 2
$gy = $before.Y + [int]($before.H / 2)
Move-Mouse $gx $gy
Start-Sleep -Milliseconds 300
Invoke-MouseDown
Start-Sleep -Milliseconds 200
for ($i = 1; $i -le 12; $i++) {
  Move-Mouse ($gx - [int](120 * $i / 12)) $gy
  Start-Sleep -Milliseconds 40
}
Start-Sleep -Milliseconds 300
Invoke-MouseUp
Start-Sleep -Milliseconds 800
$after = Get-DevHubWindows | Where-Object { $_.X -gt 1000 -and $_.H -lt 200 } | Select-Object -First 1
Write-Output ("after resize:  {0},{1} {2}x{3}" -f $after.X, $after.Y, $after.W, $after.H)
$dw = $after.W - $before.W
Write-Output ("width delta: {0}px physical ({1:N0} DIP)" -f $dw, ($dw / 1.25))
if ([Math]::Abs($dw) -ge 80) { Write-Output 'RESULT: RESIZE-OK' } else { Write-Output 'RESULT: RESIZE-INSUFFICIENT'; exit 3 }
