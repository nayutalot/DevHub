# AC5 acceptance helper: scroll the DevHub window content with mouse wheel at window center.
param(
  [int]$ProcId = 0,
  [int]$Notches = 10,
  [int]$Direction = -1   # -1 = scroll down, 1 = scroll up
)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Scroll {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
$h = [IntPtr]::Zero
if ($ProcId -gt 0) {
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) { $h = $p.MainWindowHandle }
} else {
  $p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $h = $p.MainWindowHandle }
}
if ($h -eq [IntPtr]::Zero) { Write-Output 'result: window_not_found'; exit 2 }
[Win32Scroll]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$r = New-Object Win32Scroll+RECT
[Win32Scroll]::GetWindowRect($h, [ref]$r) | Out-Null
$cx = [int](($r.L + $r.R) / 2); $cy = [int](($r.T + $r.B) / 2)
[Win32Scroll]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 200
for ($i = 0; $i -lt $Notches; $i++) {
  [Win32Scroll]::mouse_event(0x0800, 0, 0, $Direction * 120, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
}
Write-Output "result: scrolled notches=$Notches dir=$Direction at=($cx,$cy)"
