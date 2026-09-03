param([int]$ProcId = 0, [string]$OutPath = 'F:\Active_Project\DevHub\acceptance\ac5-agents-sessions.png')
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MaxShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
[MaxShot]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id $ProcId
$h = $p.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Write-Output 'result: window-not-found'; exit 2 }
[MaxShot]::ShowWindow($h, 3) | Out-Null   # SW_MAXIMIZE
Start-Sleep -Milliseconds 1200
$r = New-Object MaxShot+RECT
[MaxShot]::GetClientRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [MaxShot]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "result: saved=$OutPath client=${w}x${ht} printwindow=$ok"
