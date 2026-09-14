# count-dialogs.ps1 — 枚举 DevHub 进程的可见顶层对话框窗口（#32770，只读检测，零输入注入）。
param()
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinEnum {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] private static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll")] private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  public static List<string> DialogsOf(uint targetPid) {
    var res = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == targetPid && IsWindowVisible(h)) {
        var cn = new StringBuilder(256); GetClassName(h, cn, 256);
        if (cn.ToString() == "#32770") {
          var tt = new StringBuilder(256); GetWindowText(h, tt, 256);
          res.Add(tt.ToString());
        }
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@
$procs = Get-Process DevHub -ErrorAction SilentlyContinue
$all = @()
foreach ($p in $procs) {
  $all += [WinEnum]::DialogsOf([uint32]$p.Id)
}
Write-Output ("COUNT=" + $all.Count)
$all | ForEach-Object { Write-Output ("DLG=" + $_) }
