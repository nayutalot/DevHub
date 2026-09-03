# AC9 diagnostic v3: click chevron, then enumerate top-level windows via Win32 to see
# whether the tray overflow flyout actually opened, plus a CopyFromScreen probe.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Diag9 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
[Win32Diag9]::SetProcessDPIAware() | Out-Null

function Dump-Windows($tag) {
  Write-Host "--- top-level windows ($tag) ---"
  $cb = [Win32Diag9+EnumProc] {
    param($h, $l)
    if ([Win32Diag9]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 256
      [Win32Diag9]::GetClassName($h, $sb, 256) | Out-Null
      $cn = $sb.ToString()
      if ($cn -match 'Overflow|Notify|Xaml|Flyout|Tray|Taskbar|#32768') {
        $r = New-Object Win32Diag9+RECT
        [Win32Diag9]::GetWindowRect($h, [ref]$r) | Out-Null
        Write-Host ("hwnd=0x" + $h.ToInt64().ToString('X') + " class=[" + $cn + "] rect=" + $r.L + "," + $r.T + "," + ($r.R - $r.L) + "x" + ($r.B - $r.T))
      }
    }
    return $true
  }
  [Win32Diag9]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
}

Dump-Windows 'before'

# click chevron at known position
[Win32Diag9]::SetCursorPos(2130, 1410) | Out-Null
Start-Sleep -Milliseconds 200
[Win32Diag9]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[Win32Diag9]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Write-Host 'chevron clicked at (2130,1410)'
Start-Sleep -Milliseconds 2500

Dump-Windows 'after'

# CopyFromScreen probe
$bmp = New-Object System.Drawing.Bitmap(400, 200)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(1900, 1300, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save('F:\Active_Project\DevHub\acceptance\ac9-screen-probe.png', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host 'screen probe saved: acceptance/ac9-screen-probe.png'
