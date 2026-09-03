param([long]$Target = 0, [int]$X = 0, [int]$Y = 0)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Post {
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint msg, UIntPtr w, IntPtr l);
}
"@
$lp = [IntPtr](($Y -shl 16) -bor ($X -band 0xFFFF))
[Win32Post]::PostMessage([IntPtr]$Target, 0x0200, [UIntPtr]::Zero, $lp) | Out-Null
Start-Sleep -Milliseconds 80
$r1 = [Win32Post]::PostMessage([IntPtr]$Target, 0x0201, [UIntPtr]::new(1), $lp)
Start-Sleep -Milliseconds 80
$r2 = [Win32Post]::PostMessage([IntPtr]$Target, 0x0202, [UIntPtr]::Zero, $lp)
Write-Output "result: posted down=$r1 up=$r2 at client=($X,$Y) target=0x$($Target.ToString('X'))"
