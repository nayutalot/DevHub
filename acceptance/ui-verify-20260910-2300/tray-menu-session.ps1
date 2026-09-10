# tray-menu-session.ps1 — open DevHub tray context menu via the Electron kNotifyIconMessage
# protocol (WM_APP+1, wParam=icon_id=2, lParam=WM_CONTEXTMENU), enumerate items via UIA,
# optionally Invoke a named item. Mouseless except zero cursor movement.
param(
  [string]$InvokeItem = '',   # exact menu item name to invoke (empty = just enumerate + ESC)
  [string]$ShotName = ''      # optional region screenshot filename for the menu
)
. (Join-Path $PSScriptRoot 'tray-uia-common.ps1')
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WMC5 {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string cls, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
# locate tray host window fresh each session (class + DevHub pid)
$pids = @(Get-CimInstance Win32_Process -Filter "Name='DevHub.exe'" | Select-Object -ExpandProperty ProcessId)
$hwnd = [IntPtr]::Zero
$h = [WMC5]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, 'Electron_NotifyIconHostWindow', $null)
while ($h -ne [IntPtr]::Zero) {
  $p = [uint32]0
  [WMC5]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($pids -contains [int]$p) { $hwnd = $h; break }
  $h = [WMC5]::FindWindowEx([IntPtr]::Zero, $h, 'Electron_NotifyIconHostWindow', $null)
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'RESULT: HOST-NOT-FOUND'; exit 2 }
Write-Output ("tray host: 0x{0:X}" -f $hwnd.ToInt64())

# Bridge to the CURRENT foreground thread (canonical AttachThreadInput pattern), then
# move activation to the tray host. No mouse, no clicks.
$devhubThread = [WMC5]::GetWindowThreadProcessId($hwnd, [ref]([uint32]0))
$myThread = [WMC5]::GetCurrentThreadId()
$fgHwnd = [MLib]::GetForegroundWindow()
$fgThread = [WMC5]::GetWindowThreadProcessId($fgHwnd, [ref]([uint32]0))
Write-Output ("threads: my=$myThread devhub=$devhubThread fg=$fgThread")
[WMC5]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null
[WMC5]::AttachThreadInput($myThread, $devhubThread, $true) | Out-Null
$fgOk = [WMC5]::SetForegroundWindow($hwnd)
[WMC5]::AttachThreadInput($myThread, $devhubThread, $false) | Out-Null
[WMC5]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
Write-Output ("foreground bridge: SetForegroundWindow=" + $fgOk)
Start-Sleep -Milliseconds 400

[WMC5]::PostMessage($hwnd, 0x8001, [IntPtr]2, [IntPtr]0x007B) | Out-Null
$items = @()
foreach ($attempt in 0..1) {
  if ($attempt -eq 1) {
    # retry the foreground bridge once (race with other focus changes)
    $devhubThread2 = [WMC5]::GetWindowThreadProcessId($hwnd, [ref]([uint32]0))
    $fgHwnd2 = [MLib]::GetForegroundWindow()
    $fgThread2 = [WMC5]::GetWindowThreadProcessId($fgHwnd2, [ref]([uint32]0))
    [WMC5]::AttachThreadInput($myThread, $fgThread2, $true) | Out-Null
    [WMC5]::AttachThreadInput($myThread, $devhubThread2, $true) | Out-Null
    [WMC5]::SetForegroundWindow($hwnd) | Out-Null
    [WMC5]::AttachThreadInput($myThread, $devhubThread2, $false) | Out-Null
    [WMC5]::AttachThreadInput($myThread, $fgThread2, $false) | Out-Null
    [WMC5]::PostMessage($hwnd, 0x8001, [IntPtr]2, [IntPtr]0x007B) | Out-Null
  }
  foreach ($i in 0..29) {
    Start-Sleep -Milliseconds 75
    $items = @(Get-TrayMenuItems)
    if ($items.Count -gt 0) { break }
  }
  if ($items.Count -gt 0) { break }
}
if ($items.Count -eq 0) { Write-Output 'RESULT: NO-MENU'; exit 3 }
Write-Output ("menu items: " + $items.Count)
$idx = 0
$target = $null
foreach ($it in $items) {
  $nm = $it.Current.Name
  $ir = $it.Current.BoundingRectangle
  $ts = ''
  try { $ts = ' toggle=' + ($it.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState } catch { }
  Write-Output ("menuitem[" + $idx + "]: name=[" + $nm + "] enabled=" + $it.Current.IsEnabled + $ts + " rect=" + [int]$ir.X + "," + [int]$ir.Y + "," + [int]$ir.Width + "," + [int]$ir.Height)
  if ($InvokeItem -ne '' -and $nm -eq $InvokeItem) { $target = $it }
  $idx++
}
if ($ShotName -ne '') {
  $mr = $items[0].Current.BoundingRectangle
  Save-RegionShot ([int]($mr.X - 30)) ([Math]::Max(0, [int]($mr.Y - 40))) 560 ([int]($items.Count * 40 + 90)) (Join-Path $PSScriptRoot $ShotName)
}
if ($null -ne $target) {
  $ok = Invoke-MenuItem $target
  Write-Output ("invoked=[" + $InvokeItem + "] ok=" + $ok)
} else {
  Send-Key 0x1B  # ESC closes menu (menu has keyboard focus)
  Write-Output 'menu closed (ESC)'
}
Write-Output 'RESULT: SESSION-DONE'
