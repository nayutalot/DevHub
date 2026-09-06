# M3-C2 helper: UIA click on ANY element type by name needle (buttons/links/text)
param(
  [int]$ProcId = 37708,
  [string]$Needle = '',
  [int]$Index = 0,   # 0-based pick among matches
  [switch]$List      # list matches only
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Msg2 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint msg, UIntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
[Win32Msg2]::SetProcessDPIAware() | Out-Null
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wc)
if (-not $win) { Write-Output 'result: window_not_found'; exit 2 }
$hwnd = New-Object IntPtr($win.Current.NativeWindowHandle)
$els = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$hits = @()
foreach ($e in $els) {
  $n = $e.Current.Name
  if ($n -and $n -like ('*' + $Needle + '*')) { $hits += $e }
}
if ($hits.Count -eq 0) { Write-Output "result: needle_not_found $Needle"; exit 3 }
if ($List) {
  $k = 0
  foreach ($e in $hits) {
    $r = $e.Current.BoundingRectangle
    Write-Output ("match" + $k + ": [" + $e.Current.ControlType.ProgrammaticName + "] '" + $e.Current.Name + "' rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "x" + [int]$r.Height)
    $k++
  }
  Write-Output "result: total=$($hits.Count)"
  exit 0
}
if ($Index -ge $hits.Count) { Write-Output "result: index_out_of_range total=$($hits.Count)"; exit 4 }
$e = $hits[$Index]
$r = $e.Current.BoundingRectangle
$cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
$wr = New-Object Win32Msg2+RECT
[Win32Msg2]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
$lx = $cx - $wr.L; $ly = $cy - $wr.T
$lp = [IntPtr](($ly -shl 16) -bor ($lx -band 0xFFFF))
$child = [Win32Msg2]::FindWindowExW($hwnd, [IntPtr]::Zero, 'Chrome_RenderWidgetHostHWND', $null)
$target = if ($child -ne [IntPtr]::Zero) { $child } else { $hwnd }
[Win32Msg2]::PostMessage($target, 0x0200, [UIntPtr]::Zero, $lp) | Out-Null
Start-Sleep -Milliseconds 80
[Win32Msg2]::PostMessage($target, 0x0201, [UIntPtr][uint32]1, $lp) | Out-Null
Start-Sleep -Milliseconds 80
[Win32Msg2]::PostMessage($target, 0x0202, [UIntPtr]::Zero, $lp) | Out-Null
Write-Output "result: posted_click needle=[$($e.Current.Name)] type=[$($e.Current.ControlType.ProgrammaticName)] screen=($cx,$cy) client=($lx,$ly)"
