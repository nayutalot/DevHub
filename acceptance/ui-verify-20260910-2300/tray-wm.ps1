. (Join-Path $PSScriptRoot 'tray-uia-common.ps1')
# Find candidate hidden top-level windows owned by DevHub.exe for WM_CONTEXTMENU
$pids = @(Get-CimInstance Win32_Process -Filter "Name='DevHub.exe'" | Select-Object -ExpandProperty ProcessId)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WMC {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(WMC.EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
$script:cands = New-Object System.Collections.ArrayList
$cb = [WMC+EnumProc]{
  param($h, $l)
  $p = [uint32]0
  [WMC]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($pids -contains [int]$p) {
    $sb = New-Object System.Text.StringBuilder 256
    [WMC]::GetClassName($h, $sb, 256) | Out-Null
    [void]$script:cands.Add([PSCustomObject]@{ H = $h; Class = $sb.ToString(); Vis = [WMC]::IsWindowVisible($h) })
  }
  return $true
}
[WMC]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$script:cands | ForEach-Object { Write-Host ("cand hwnd=0x{0:X} class=[{1}] visible={2}" -f $_.H.ToInt64(), $_.Class, $_.Vis) }
# WM_CONTEXTMENU = 0x007B; wParam = hwnd of icon window; lParam = screen coords (tray chevron area)
$lx = 2162 -band 0xFFFF
$ly = 1410 -shl 16
$lparam = [IntPtr]($ly -bor $lx)
foreach ($c in $script:cands) {
  if ($c.Class -notmatch 'Chrome_WidgetWin|Shell_') { continue }
  [WMC]::PostMessage($c.H, 0x007B, $c.H, $lparam) | Out-Null
  Start-Sleep -Milliseconds 1200
  $items = Get-TrayMenuItems
  Write-Host ("posted WM_CONTEXTMENU to 0x{0:X} [{1}] -> menu items: {2}" -f $c.H.ToInt64(), $c.Class, $items.Count)
  if ($items.Count -gt 0) {
    for ($i = 0; $i -lt $items.Count; $i++) {
      $it = $items[$i]
      $ir = $it.Current.BoundingRectangle
      $ts = ''
      try { $ts = ' toggle=' + ($it.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState } catch { }
      Write-Host ("menuitem[" + $i + "]: name=[" + $it.Current.Name + "] enabled=" + $it.Current.IsEnabled + $ts + " rect=" + [int]$ir.X + "," + [int]$ir.Y + "," + [int]$ir.Width + "," + [int]$ir.Height)
    }
    Write-Output ("RESULT: MENU-OPEN items=" + $items.Count)
    exit 0
  }
}
Write-Output 'RESULT: NO-MENU'
