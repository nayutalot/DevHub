param([int]$ProcId = 0, [int]$X = 0, [int]$Y = 0)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Click {
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint msg, UIntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wc)
if (-not $win) { Write-Output 'result: window_not_found'; exit 2 }
$hwnd = New-Object IntPtr($win.Current.NativeWindowHandle)
$child = [Win32Click]::FindWindowExW($hwnd, [IntPtr]::Zero, 'Chrome_RenderWidgetHostHWND', $null)
$target = if ($child -ne [IntPtr]::Zero) { $child } else { $hwnd }
$lp = [IntPtr](($Y -shl 16) -bor ($X -band 0xFFFF))
[Win32Click]::PostMessage($target, 0x0200, [UIntPtr]::Zero, $lp) | Out-Null
Start-Sleep -Milliseconds 80
[Win32Click]::PostMessage($target, 0x0201, [UIntPtr]::new(1), $lp) | Out-Null
Start-Sleep -Milliseconds 80
[Win32Click]::PostMessage($target, 0x0202, [UIntPtr]::Zero, $lp) | Out-Null
Write-Output "result: clicked client=($X,$Y) target=0x$($target.ToInt64().ToString('X'))"
