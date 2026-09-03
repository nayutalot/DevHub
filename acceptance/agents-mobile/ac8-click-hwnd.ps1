param([long]$Hwnd = 0, [int]$ClientX = 0, [int]$ClientY = 0)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Cli2 {
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
[Win32Cli2]::SetProcessDPIAware() | Out-Null
$h = [IntPtr]$Hwnd
[Win32Cli2]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
$pt = New-Object Win32Cli2+POINT; $pt.X = $ClientX; $pt.Y = $ClientY
[Win32Cli2]::ClientToScreen($h, [ref]$pt) | Out-Null
[Win32Cli2]::SetCursorPos($pt.X, $pt.Y) | Out-Null
Start-Sleep -Milliseconds 150
[Win32Cli2]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[Win32Cli2]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Write-Output "result: clicked screen=($($pt.X),$($pt.Y)) hwnd=0x$($h.ToString('X'))"
