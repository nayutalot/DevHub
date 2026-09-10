. (Join-Path $PSScriptRoot 'tray-uia-common.ps1')
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WMC2 {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
$host_ = [IntPtr]0x2707C0
# verify the hwnd still exists and belongs to DevHub
$p = [uint32]0
[MLib]::GetWindowThreadProcessId($host_, [ref]$p) | Out-Null
$pn = (Get-Process -Id $p -ErrorAction SilentlyContinue).Name
Write-Host ("tray host hwnd=0x2707C0 pid=$p proc=$pn")
if ($pn -ne 'DevHub') { Write-Output 'RESULT: HOST-HWND-STALE'; exit 2 }
$lx = 2162 -band 0xFFFF
$ly = 1410 -shl 16
$lparam = [IntPtr]($ly -bor $lx)
[WMC2]::PostMessage($host_, 0x007B, $host_, $lparam) | Out-Null
Start-Sleep -Milliseconds 2000
$items = Get-TrayMenuItems
Write-Host ("menu items: " + $items.Count)
for ($i = 0; $i -lt $items.Count; $i++) {
  $it = $items[$i]
  $ir = $it.Current.BoundingRectangle
  $ts = ''
  try { $ts = ' toggle=' + ($it.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState } catch { }
  Write-Host ("menuitem[" + $i + "]: name=[" + $it.Current.Name + "] enabled=" + $it.Current.IsEnabled + $ts + " rect=" + [int]$ir.X + "," + [int]$ir.Y + "," + [int]$ir.Width + "," + [int]$ir.Height)
}
if ($items.Count -gt 0) {
  $mw = $script:RootEl.FindChildren([System.Windows.Automation.AutomationElement]::RootElement, $script:MenuCond) 
  Write-Output ("RESULT: MENU-OPEN items=" + $items.Count)
} else {
  Write-Output 'RESULT: NO-MENU'
}
