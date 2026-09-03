param([long]$Hwnd = 0)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Enum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
}
"@
$cb = [Win32Enum+EnumProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [Win32Enum]::GetClassName($h, $sb, 256) | Out-Null
  $tb = New-Object System.Text.StringBuilder 256
  [Win32Enum]::GetWindowText($h, $tb, 256) | Out-Null
  Write-Output ("child: 0x" + $h.ToString('X') + " class=[" + $sb.ToString() + "] title=[" + $tb.ToString() + "]")
  return $true
}
[Win32Enum]::EnumChildWindows([IntPtr]$Hwnd, $cb, [IntPtr]::Zero) | Out-Null
