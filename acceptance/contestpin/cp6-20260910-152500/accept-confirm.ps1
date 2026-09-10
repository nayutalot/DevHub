param([int]$ProcId = 36136)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Confirm1 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
$dialog = [IntPtr]::Zero
$cb = [Confirm1+EnumProc]{
  param($h, $l)
  $p = [uint32]0
  [Confirm1]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq [uint32]$ProcId -and [Confirm1]::IsWindowVisible($h)) {
    $sc = New-Object System.Text.StringBuilder 256
    [Confirm1]::GetClassNameW($h, $sc, 256) | Out-Null
    if ($sc.ToString() -eq '#32770') { $script:dialog = $h; return $false }
  }
  return $true
}
[Confirm1]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($dialog -eq [IntPtr]::Zero) { Write-Output 'result: dialog_not_found'; exit 2 }
Write-Output ('confirm hwnd=0x' + $dialog.ToInt64().ToString('X'))
# IDYES = 6（任务对话框 yes 按钮；window.confirm 确定键）
[Confirm1]::SendMessageW($dialog, 0x0111, [IntPtr]6, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 500
Write-Output 'result: sent IDYES'
