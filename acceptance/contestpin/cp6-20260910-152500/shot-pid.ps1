param(
  [string]$OutPath = 'shot.png',
  [int]$TargetPid = 0
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinShot3 {
  public struct RECT { public int L; public int T; public int R; public int B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
}
"@
[WinShot3]::SetProcessDPIAware() | Out-Null
$found = New-Object System.Collections.ArrayList
$cb = [WinShot3+EnumProc]{
  param($h, $l)
  $pid2 = [uint32]0
  [WinShot3]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($pid2 -eq [uint32]$TargetPid -and [WinShot3]::IsWindowVisible($h)) {
    $r = New-Object WinShot3+RECT
    [WinShot3]::GetClientRect($h, [ref]$r) | Out-Null
    $sb = New-Object System.Text.StringBuilder 256
    [WinShot3]::GetWindowTextW($h, $sb, 256) | Out-Null
    [void]$found.Add(@{ H = $h; W = ($r.R - $r.L); Ht = ($r.B - $r.T); Title = $sb.ToString() })
  }
  return $true
}
[WinShot3]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
foreach ($f in $found) { Write-Output ("cand hwnd=0x{0:X} {1}x{2} title='{3}'" -f $f.H.ToInt64(), $f.W, $f.Ht, $f.Title) }
$big = $found | Where-Object { $_.W -ge 300 -and $_.Ht -ge 300 } | Sort-Object { $_.W * $_.Ht } -Descending | Select-Object -First 1
$best = $big
if ($null -eq $best) {
  # 最小化窗口 client=0x0（或唯一可见窗过小）：SW_RESTORE 后重取客户区
  $zero = $found | Where-Object { $_.W -lt 300 -or $_.Ht -lt 300 } | Sort-Object { $_.W * $_.Ht } | Select-Object -First 1
  if ($null -eq $zero) { Write-Output 'result: no suitable window'; exit 2 }
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinRestore { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
  [WinRestore]::ShowWindow($zero.H, 9) | Out-Null
  [WinRestore]::SetForegroundWindow($zero.H) | Out-Null
  Start-Sleep -Milliseconds 1200
  $r = New-Object WinShot3+RECT
  [WinShot3]::GetClientRect($zero.H, [ref]$r) | Out-Null
  $zero.W = $r.R - $r.L; $zero.Ht = $r.B - $r.T
  $best = $zero
}
$w = [int]$best.W; $ht = [int]$best.Ht
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [WinShot3]::PrintWindow($best.H, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "result: saved=$OutPath client=${w}x${ht} printwindow=$ok"
