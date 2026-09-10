. (Join-Path $PSScriptRoot 'tray-uia-common.ps1')
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WMC4 {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string cls, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$host_ = [IntPtr]0x2707C0
$p = [uint32]0
[WMC4]::GetWindowThreadProcessId($host_, [ref]$p) | Out-Null
if ((Get-Process -Id $p -ErrorAction SilentlyContinue).Name -ne 'DevHub') { Write-Output 'RESULT: HOST-STALE'; exit 2 }
$seen = 0
foreach ($combo in @(@(1,0), @(0,1), @(0,0))) {
  $wParam = [IntPtr](($combo[0] -band 0xFFFF) -bor (($combo[1] -band 0xFFFF) -shl 16))
  [WMC4]::PostMessage($host_, 0x8001, $wParam, [IntPtr]0x0205) | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    $menuWnd = [WMC4]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, '#32768', $null)
    if ($menuWnd -ne [IntPtr]::Zero) { $seen++; Write-Output ("combo w=" + $combo[0] + "/" + $combo[1] + ": #32768 APPEARED at poll " + $i) }
    Start-Sleep -Milliseconds 100
  }
  Write-Output ("combo w=" + $combo[0] + "/" + $combo[1] + ": done, sightings so far=" + $seen)
}
Write-Output ("RESULT: total sightings=" + $seen)
