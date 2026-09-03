# AC5 acceptance helper: bring DevHub to foreground (ALT-key trick) and send keystrokes.
param(
  [int]$ProcId = 0,
  [string]$Keys = '{PGDN}',
  [int]$Repeat = 1
)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Key {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
Add-Type -AssemblyName System.Windows.Forms
$h = [IntPtr]::Zero
if ($ProcId -gt 0) {
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) { $h = $p.MainWindowHandle }
} else {
  $p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $h = $p.MainWindowHandle }
}
if ($h -eq [IntPtr]::Zero) { Write-Output 'result: window_not_found'; exit 2 }
if ([Win32Key]::IsIconic($h)) { [Win32Key]::ShowWindow($h, 9) | Out-Null }
# ALT key trick: allows SetForegroundWindow from a background process
[Win32Key]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[Win32Key]::SetForegroundWindow($h) | Out-Null
[Win32Key]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 500
$fg = [Win32Key]::GetForegroundWindow()
$ok = ($fg -eq $h)
for ($i = 0; $i -lt $Repeat; $i++) {
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  Start-Sleep -Milliseconds 250
}
Write-Output "result: keys='$Keys' x$Repeat foreground=$ok"
