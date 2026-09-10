param([int]$ProcId = 36136, [double]$CssX = 0, [double]$CssY = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FG2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  public struct RECT { public int L; public int T; public int R; public int B; }
  public struct POINT { public int X; public int Y; }
}
"@
[FG2]::SetProcessDPIAware() | Out-Null
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $wc)
$best = $null
$bestArea = 0.0
foreach ($w in $wins) {
  $r = $w.Current.BoundingRectangle
  $a = $r.Width * $r.Height
  if ($a -gt $bestArea) { $bestArea = $a; $best = $w }
}
if ($null -eq $best) { Write-Output 'result: window_not_found'; exit 2 }
$h = [IntPtr]$best.Current.NativeWindowHandle
[FG2]::ShowWindow($h, 9) | Out-Null
[FG2]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800

$rect = New-Object FG2+RECT
$pt = New-Object FG2+POINT
$pt.X = 0
$pt.Y = 0
[FG2]::GetClientRect($h, [ref]$rect) | Out-Null
[FG2]::ClientToScreen($h, [ref]$pt) | Out-Null
$clientW = $rect.R - $rect.L
$clientH = $rect.B - $rect.T
$cssW = 1266.0
$scale = $clientW / $cssW
$physX = [int]($pt.X + $CssX * $scale)
$physY = [int]($pt.Y + $CssY * $scale)
Write-Output ("client origin=({0},{1}) size={2}x{3} scale={4} click=({5},{6})" -f $pt.X, $pt.Y, $clientW, $clientH, $scale, $physX, $physY)
[FG2]::SetCursorPos($physX, $physY) | Out-Null
Start-Sleep -Milliseconds 200
[FG2]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[FG2]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Write-Output 'clicked'
