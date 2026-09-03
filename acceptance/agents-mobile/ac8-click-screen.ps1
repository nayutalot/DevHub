param([int]$ProcId = 0, [int]$ClientX = 0, [int]$ClientY = 0)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Cli {
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
[Win32Cli]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
$h = $p.MainWindowHandle
$pt = New-Object Win32Cli+POINT; $pt.X = $ClientX; $pt.Y = $ClientY
[Win32Cli]::ClientToScreen($h, [ref]$pt) | Out-Null
[Win32Cli]::SetCursorPos($pt.X, $pt.Y) | Out-Null
Start-Sleep -Milliseconds 120
[Win32Cli]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
Start-Sleep -Milliseconds 60
[Win32Cli]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
Write-Output "result: clicked screen=($($pt.X),$($pt.Y)) hwnd=0x$h"
