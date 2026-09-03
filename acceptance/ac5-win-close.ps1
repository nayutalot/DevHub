# UIA WindowPattern.Close on the DevHub main window (equiv to clicking the X button)
param([int]$ProcId = 0)
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinVis {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wc)
if (-not $win) { Write-Output 'result: window-not-found'; exit 2 }
try {
  $wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
  $wp.Close()
  Write-Output 'result: window-close-invoked (UIA WindowPattern)'
} catch {
  Write-Output ("result: windowpattern-unavailable: " + $_.Exception.Message)
  exit 3
}
Start-Sleep -Milliseconds 800
$p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
$hwnd = $p.MainWindowHandle
Write-Output ("post-close: processAlive=" + ($null -ne $p) + " mainWindowHandle=" + $hwnd + " visible=" + ([WinVis]::IsWindowVisible($hwnd)))
