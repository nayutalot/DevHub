. (Join-Path $PSScriptRoot 'tray-uia-common.ps1')
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WMB {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string cls, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
$pids = @(Get-CimInstance Win32_Process -Filter "Name='DevHub.exe'" | Select-Object -ExpandProperty ProcessId)
$hwnd = [IntPtr]::Zero
$h = [WMB]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, 'Electron_NotifyIconHostWindow', $null)
while ($h -ne [IntPtr]::Zero) {
  $p = [uint32]0
  [WMB]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($pids -contains [int]$p) { $hwnd = $h; break }
  $h = [WMB]::FindWindowEx([IntPtr]::Zero, $h, 'Electron_NotifyIconHostWindow', $null)
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'RESULT: HOST-NOT-FOUND'; exit 2 }
$my = [WMB]::GetCurrentThreadId()
foreach ($id in 1..10) {
  $fgH = [MLib]::GetForegroundWindow()
  $fgT = [WMB]::GetWindowThreadProcessId($fgH, [ref]([uint32]0))
  $dT = [WMB]::GetWindowThreadProcessId($hwnd, [ref]([uint32]0))
  [WMB]::AttachThreadInput($my, $fgT, $true) | Out-Null
  [WMB]::AttachThreadInput($my, $dT, $true) | Out-Null
  $ok = [WMB]::SetForegroundWindow($hwnd)
  [WMB]::AttachThreadInput($my, $dT, $false) | Out-Null
  [WMB]::AttachThreadInput($my, $fgT, $false) | Out-Null
  Start-Sleep -Milliseconds 250
  [WMB]::PostMessage($hwnd, 0x8001, [IntPtr]$id, [IntPtr]0x007B) | Out-Null
  Start-Sleep -Milliseconds 700
  $items = @(Get-TrayMenuItems)
  Write-Output ("id=$id fgOk=$ok menuItems=" + $items.Count)
  if ($items.Count -gt 0) {
    foreach ($it in $items) {
      $ir = $it.Current.BoundingRectangle
      Write-Output ("  item: name=[" + $it.Current.Name + "] rect=" + [int]$ir.X + "," + [int]$ir.Y + "," + [int]$ir.Width + "," + [int]$ir.Height)
    }
    Write-Output ("RESULT: MENU-OPEN id=" + $id)
    exit 0
  }
}
Write-Output 'RESULT: NO-MENU-ANY-ID'
