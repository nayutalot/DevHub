param([int]$ProcId = 6776, [string]$FilePath = 'C:\Users\sakuya\AppData\Local\Temp\devhub-cp6-acceptance-out\manifest.json')
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Dlg2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
$dialog = [IntPtr]::Zero
$cb = [Dlg2+EnumProc]{
  param($h, $l)
  $p = [uint32]0
  [Dlg2]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq [uint32]$ProcId -and [Dlg2]::IsWindowVisible($h)) {
    $sc = New-Object System.Text.StringBuilder 256
    [Dlg2]::GetClassNameW($h, $sc, 256) | Out-Null
    if ($sc.ToString() -eq '#32770') { $script:dialog = $h; return $false }
  }
  return $true
}
[Dlg2]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($dialog -eq [IntPtr]::Zero) { Write-Output 'result: dialog_not_found'; exit 2 }
Write-Output ('dialog hwnd=0x' + $dialog.ToInt64().ToString('X'))

$editH = [IntPtr]::Zero
$ecb = [Dlg2+EnumProc]{
  param($h, $l)
  $sc = New-Object System.Text.StringBuilder 256
  [Dlg2]::GetClassNameW($h, $sc, 256) | Out-Null
  if ($sc.ToString() -eq 'Edit') { $script:editH = $h; return $false }
  return $true
}
[Dlg2]::EnumChildWindows($dialog, $ecb, [IntPtr]::Zero) | Out-Null
if ($editH -eq [IntPtr]::Zero) { Write-Output 'result: edit_not_found'; exit 3 }
Write-Output ('edit hwnd=0x' + $editH.ToInt64().ToString('X'))
[Dlg2]::SendMessageW($editH, 0x000C, [IntPtr]::Zero, $FilePath) | Out-Null
Start-Sleep -Milliseconds 600
[Dlg2]::PostMessageW($dialog, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 600
Write-Output 'result: set path and posted IDOK'
