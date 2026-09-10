param([IntPtr]$Dlg = [IntPtr]::Zero)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Confirm2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$btns = New-Object System.Collections.ArrayList
$cb = [Confirm2+EnumProc]{
  param($h, $l)
  $sc = New-Object System.Text.StringBuilder 256
  [Confirm2]::GetClassNameW($h, $sc, 256) | Out-Null
  if ($sc.ToString() -eq 'Button') {
    $sb = New-Object System.Text.StringBuilder 128
    [Confirm2]::GetWindowTextW($h, $sb, 128) | Out-Null
    [void]$btns.Add([PSCustomObject]@{ H = $h; Text = $sb.ToString() })
  }
  return $true
}
[Confirm2]::EnumChildWindows($Dlg, $cb, [IntPtr]::Zero) | Out-Null
foreach ($b in $btns) { Write-Output ("  btn 0x{0:X} '{1}'" -f $b.H.ToInt64(), $b.Text) }
$yes = $btns | Where-Object { $_.Text -match '&Yes|是|确定|OK' } | Select-Object -First 1
if ($null -eq $yes -and $btns.Count -gt 0) { $yes = $btns[0] }
if ($null -eq $yes) { Write-Output 'result: no button'; exit 2 }
[Confirm2]::SetForegroundWindow($Dlg) | Out-Null
Start-Sleep -Milliseconds 300
[Confirm2]::SendMessageW($yes.H, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 500
Write-Output ('result: clicked btn 0x' + $yes.H.ToInt64().ToString('X') + ' ' + $yes.Text)
