param([string]$cmd, [int]$x, [int]$y, [string]$text)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public struct POINT { public int X, Y; }
}
"@
if ($cmd -eq "fg") {
  $h = [Win32]::GetForegroundWindow()
  $pid2 = 0
  [Win32]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  $sb = New-Object System.Text.StringBuilder 256
  [Win32]::GetWindowText($h, $sb, 256) | Out-Null
  $rect = New-Object Win32+RECT
  [Win32]::GetWindowRect($h, [ref]$rect) | Out-Null
  $p = New-Object Win32+POINT
  [Win32]::GetCursorPos([ref]$p) | Out-Null
  Write-Output ("fg_window='{0}' process='{1}' pid={2} rect=({3},{4})-({5},{6}) cursor=({7},{8})" -f $sb.ToString(), $proc.ProcessName, $pid2, $rect.Left, $rect.Top, $rect.Right, $rect.Bottom, $p.X, $p.Y)
} elseif ($cmd -eq "shot") {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($text, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "saved: $text"
} elseif ($cmd -eq "click") {
  [Win32]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  [Win32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [Win32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Write-Output "clicked ($x,$y)"
} elseif ($cmd -eq "type") {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait($text)
  Write-Output "typed: $text"
} elseif ($cmd -eq "focus") {
  $h = [Win32]::GetForegroundWindow()
  $proc2 = 0
  [Win32]::GetWindowThreadProcessId($h, [ref]$proc2) | Out-Null
  $devhub = Get-Process -Name DevHub -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($devhub -ne $null) {
    [Win32]::SetForegroundWindow($devhub.MainWindowHandle) | Out-Null
    Write-Output ("focused DevHub hwnd (prev fg pid={0})" -f $proc2)
  } else { Write-Output "no DevHub main window found" }
}
if ($cmd -eq "client") {
  Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect); [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);' -Name Win32X -Namespace W
  $h = (Get-Process -Name DevHub -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
  if ($h -eq $null -or $h -eq 0) { Write-Output "no devhub window"; exit }
  $r = New-Object Win32+RECT
  [W.Win32X]::GetClientRect($h, [ref]$r) | Out-Null
  $p = New-Object Win32+POINT
  $p.X = 0; $p.Y = 0
  [W.Win32X]::ClientToScreen($h, [ref]$p) | Out-Null
  Write-Output ("client origin=({0},{1}) size={2}x{3}" -f $p.X, $p.Y, $r.Right, $r.Bottom)
}
