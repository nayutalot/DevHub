param([int]$TargetPid = 0)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum4 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
}
"@
$found = New-Object System.Collections.ArrayList
$cb = [WinEnum4+EnumProc]{
  param($h, $l)
  $p = [uint32]0
  [WinEnum4]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq [uint32]$TargetPid -and [WinEnum4]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinEnum4]::GetWindowTextW($h, $sb, 256) | Out-Null
    $sc = New-Object System.Text.StringBuilder 256
    [WinEnum4]::GetClassNameW($h, $sc, 256) | Out-Null
    [void]$found.Add([PSCustomObject]@{ H = '0x' + $h.ToInt64().ToString('X'); Title = $sb.ToString(); Class = $sc.ToString() })
  }
  return $true
}
[WinEnum4]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$found | Format-Table -AutoSize | Out-String -Width 160
