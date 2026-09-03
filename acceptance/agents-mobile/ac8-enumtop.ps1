Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Top {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
}
"@
$want = @(35336, 12208, 36692, 33816)
$cb = [Win32Top+EnumProc]{
  param($h, $l)
  $pid2 = 0
  [Win32Top]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($want -contains [int]$pid2) {
    $sb = New-Object System.Text.StringBuilder 256
    [Win32Top]::GetClassName($h, $sb, 256) | Out-Null
    $tb = New-Object System.Text.StringBuilder 256
    [Win32Top]::GetWindowText($h, $tb, 256) | Out-Null
    $vis = [Win32Top]::IsWindowVisible($h)
    Write-Output ("top: 0x" + $h.ToString('X') + " pid=" + $pid2 + " class=[" + $sb.ToString() + "] title=[" + $tb.ToString() + "] visible=" + $vis)
    $cb2 = [Win32Top+EnumProc]{
      param($h2, $l2)
      $sb2 = New-Object System.Text.StringBuilder 256
      [Win32Top]::GetClassName($h2, $sb2, 256) | Out-Null
      Write-Output ("  child: 0x" + $h2.ToString('X') + " class=[" + $sb2.ToString() + "]")
      return $true
    }
    [Win32Top]::EnumChildWindows($h, $cb2, [IntPtr]::Zero) | Out-Null
  }
  return $true
}
[Win32Top]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
