. (Join-Path $PSScriptRoot 'tray-uia-common.ps1')
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WMC3 {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string cls, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$host_ = [IntPtr]0x2707C0
$p = [uint32]0
[WMC3]::GetWindowThreadProcessId($host_, [ref]$p) | Out-Null
if ((Get-Process -Id $p -ErrorAction SilentlyContinue).Name -ne 'DevHub') { Write-Output 'RESULT: HOST-STALE'; exit 2 }
$kMsg = 0x8001  # WM_APP+1 kNotifyIconMessage
$rbUp = [IntPtr]0x0205  # WM_RBUTTONUP
$combos = @(
  @{ name='wParam=id=1 (LOWORD=1,HIWORD=0)'; w = [IntPtr](1 -bor (0 -shl 16)) },
  @{ name='wParam=index=0,id=1(HIWORD=1)';   w = [IntPtr](0 -bor (1 -shl 16)) },
  @{ name='wParam=0';                        w = [IntPtr]::Zero }
)
foreach ($c in $combos) {
  # down + up sequence
  [WMC3]::PostMessage($host_, $kMsg, $c.w, [IntPtr]0x0204) | Out-Null
  Start-Sleep -Milliseconds 120
  [WMC3]::PostMessage($host_, $kMsg, $c.w, $rbUp) | Out-Null
  Start-Sleep -Milliseconds 1500
  $menuWnd = [WMC3]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, '#32768', $null)
  $items = Get-TrayMenuItems
  Write-Host ("combo [{0}]: #32768 found={1} uia-items={2}" -f $c.name, ($menuWnd -ne [IntPtr]::Zero), $items.Count)
  if ($items.Count -gt 0) {
    for ($i = 0; $i -lt $items.Count; $i++) {
      $it = $items[$i]
      $ir = $it.Current.BoundingRectangle
      $ts = ''
      try { $ts = ' toggle=' + ($it.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState } catch { }
      Write-Host ("menuitem[" + $i + "]: name=[" + $it.Current.Name + "] enabled=" + $it.Current.IsEnabled + $ts + " rect=" + [int]$ir.X + "," + [int]$ir.Y + "," + [int]$ir.Width + "," + [int]$ir.Height)
    }
    Write-Output ("RESULT: MENU-OPEN combo=" + $c.name)
    exit 0
  }
}
Write-Output 'RESULT: NO-MENU'
