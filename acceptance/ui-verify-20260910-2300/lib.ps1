# lib.ps1 — shared user32 helpers for M-batch UI verification (DPI-aware, physical px).
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MLib {
  public struct RECT { public int L; public int T; public int R; public int B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out MLib.RECT p);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@

function Send-Esc {
  [MLib]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [MLib]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
}
[MLib]::SetProcessDPIAware() | Out-Null

function Get-DevHubPids {
  Get-CimInstance Win32_Process -Filter "Name='DevHub.exe'" | Select-Object -ExpandProperty ProcessId
}

function Get-DevHubWindows {
  # All visible top-level windows of every DevHub.exe PID: hwnd, title, class, rect (physical px)
  $pids = Get-DevHubPids
  $found = New-Object System.Collections.ArrayList
  $cb = [MLib+EnumProc]{
    param($h, $l)
    $p = [uint32]0
    [MLib]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
    if ($pids -contains [int]$p -and [MLib]::IsWindowVisible($h)) {
      $r = New-Object MLib+RECT
      [MLib]::GetWindowRect($h, [ref]$r) | Out-Null
      $sb = New-Object System.Text.StringBuilder 256
      [MLib]::GetWindowTextW($h, $sb, 256) | Out-Null
      $sc = New-Object System.Text.StringBuilder 256
      [MLib]::GetClassNameW($h, $sc, 256) | Out-Null
      [void]$found.Add([PSCustomObject]@{
        Hwnd = $h; Pid = [int]$p
        Title = $sb.ToString(); Class = $sc.ToString()
        X = $r.L; Y = $r.T; W = ($r.R - $r.L); H = ($r.B - $r.T)
      })
    }
    return $true
  }
  [MLib]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $found
}

function Move-Mouse([int]$x, [int]$y) {
  [MLib]::SetCursorPos($x, $y) | Out-Null
}
function Invoke-MouseDown { [MLib]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
function Invoke-MouseUp { [MLib]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
function Invoke-RightDown { [MLib]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero) }
function Invoke-RightUp { [MLib]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero) }

function Invoke-Click([int]$x, [int]$y) {
  Move-Mouse $x $y
  Start-Sleep -Milliseconds 150
  Invoke-MouseDown
  Start-Sleep -Milliseconds 70
  Invoke-MouseUp
}

function Save-RegionShot([int]$x, [int]$y, [int]$w, [int]$h, [string]$outPath) {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "region-shot saved: $outPath (${w}x${h} at $x,$y)"
}
