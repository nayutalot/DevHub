param([long]$Hwnd = 0)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Rect {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
$r = New-Object Win32Rect+RECT
[Win32Rect]::GetWindowRect([IntPtr]$Hwnd, [ref]$r) | Out-Null
Write-Output ("window rect: L=" + $r.L + " T=" + $r.T + " R=" + $r.R + " B=" + $r.B + " (w=" + ($r.R - $r.L) + " h=" + ($r.B - $r.T) + ")")
$c = New-Object Win32Rect+RECT
[Win32Rect]::GetClientRect([IntPtr]$Hwnd, [ref]$c) | Out-Null
Write-Output ("client: w=" + $c.R + " h=" + $c.B)
