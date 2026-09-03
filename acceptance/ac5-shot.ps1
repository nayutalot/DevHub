# AC5 acceptance helper: capture the DevHub main window via PrintWindow(PW_RENDERFULLCONTENT).
# Works without a visible/foreground desktop (HWND capture, safe under locked screen).
param(
  [int]$ProcId = 0,
  [string]$OutPath = 'F:\Active_Project\DevHub\acceptance\ac5-agents.png',
  [int]$ResizeW = 0,
  [int]$ResizeH = 0
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Shot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
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
[Win32Shot]::SetProcessDPIAware() | Out-Null
[Win32Shot]::ShowWindow($h, 9) | Out-Null
if ($ResizeW -gt 0 -and $ResizeH -gt 0) {
  [Win32Shot]::SetWindowPos($h, [IntPtr]::Zero, 40, 40, $ResizeW, $ResizeH, 0x0040) | Out-Null
  Start-Sleep -Milliseconds 900
}
Start-Sleep -Milliseconds 500
$r = New-Object Win32Shot+RECT
[Win32Shot]::GetClientRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [Win32Shot]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$vis = [Win32Shot]::IsWindowVisible($h)
Write-Output "result: hwnd=0x$($h.ToInt64().ToString('X')) saved=$OutPath client=${w}x${ht} printwindow=$ok visible=$vis"
