. 'F:\Active_Project\DevHub\acceptance\ui-verify-20260910-2300\lib.ps1'
$EV = 'F:\Active_Project\DevHub\acceptance\ui-verify-20260910-2300'
Write-Output '=== health ==='
try { (Invoke-WebRequest -Uri 'http://127.0.0.1:8746/v1/health' -UseBasicParsing -TimeoutSec 3).Content } catch { Write-Output ('health fail: ' + $_.Exception.Message) }
Write-Output '=== DevHub visible windows (physical px, DPI-aware) ==='
Get-DevHubWindows | Format-Table Hwnd, Pid, X, Y, W, H, Class, Title -AutoSize | Out-String -Width 200
Write-Output '=== overlay window PrintWindow capture (pre-restart) ==='
$ovl = Get-DevHubWindows | Where-Object { $_.W -lt 700 -and $_.W -gt 200 } | Sort-Object { $_.W * $_.H } -Descending | Select-Object -First 1
if ($ovl) {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap($ovl.W, $ovl.H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [MLib]::GetWindowRect($ovl.Hwnd, [ref]([MLib+RECT]::new())) 
  $g.ReleaseHdc($hdc); $g.Dispose()
  Write-Output ("overlay cand hwnd=0x{0:X} rect=({1},{2}) {3}x{4}" -f $ovl.Hwnd.ToInt64(), $ovl.X, $ovl.Y, $ovl.W, $ovl.H)
}
