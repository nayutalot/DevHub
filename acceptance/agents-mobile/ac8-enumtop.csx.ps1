Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Top2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  public static string Dump(int[] pids) {
    var outp = new StringBuilder();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      for (int i = 0; i < pids.Length; i++) {
        if (pids[i] == (int)pid) {
          StringBuilder cn = new StringBuilder(256), tt = new StringBuilder(256);
          GetClassName(h, cn, 256); GetWindowText(h, tt, 256);
          outp.AppendLine("top: 0x" + h.ToString("X") + " pid=" + pid + " class=[" + cn + "] title=[" + tt + "] visible=" + IsWindowVisible(h));
          EnumChildWindows(h, (h2, l2) => {
            StringBuilder cn2 = new StringBuilder(256);
            GetClassName(h2, cn2, 256);
            outp.AppendLine("  child: 0x" + h2.ToString("X") + " class=[" + cn2 + "]");
            return true;
          }, IntPtr.Zero);
        }
      }
      return true;
    }, IntPtr.Zero);
    return outp.ToString();
  }
}
"@
[Win32Top2]::Dump(@(35336, 12208, 36692, 33816)) | Write-Output
