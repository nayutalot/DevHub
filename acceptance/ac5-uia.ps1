# AC5 acceptance helper: UIA operations on DevHub window (list/scroll/click via posted messages).
param(
  [int]$ProcId = 0,
  [string]$Mode = 'listtext',   # listtext | listrows | scrollintoview | clickpoint | scrollwheel
  [string]$Needle = '',
  [int]$MaxList = 400
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Msg {
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint msg, UIntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($ProcId -gt 0) {
  $wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wc)
}
if (-not $win) { Write-Output 'result: window_not_found'; exit 2 }
$hwnd = New-Object IntPtr($win.Current.NativeWindowHandle)

function Find-SubtreeText([System.Windows.Automation.AutomationElement]$scopeWin, [string]$needle) {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text)
  $els = $scopeWin.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $hits = @()
  foreach ($e in $els) {
    $n = $e.Current.Name
    if ($n -and $n -like ('*' + $needle + '*')) { $hits += $e }
  }
  return $hits
}

switch ($Mode) {
  'listtext' {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Text)
    $els = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $i = 0
    foreach ($e in $els) {
      $n = $e.Current.Name
      if ([string]::IsNullOrEmpty($n)) { $n = '<empty>' }
      Write-Output ("text: " + $n)
      $i++
      if ($i -ge $MaxList) { break }
    }
  }
  'scrollintoview' {
    $hits = Find-SubtreeText $win $Needle
    if ($hits.Count -eq 0) { Write-Output "result: needle_not_found $Needle"; exit 3 }
    $e = $hits[0]
    try {
      $sp = $e.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
      $sp.ScrollIntoView()
      Write-Output ("result: scrolled_into_view [" + $e.Current.Name + "] rect=" + $e.Current.BoundingRectangle.ToString())
    } catch {
      Write-Output ("result: scrollpattern_unavailable [" + $e.Current.Name + "] rect=" + $e.Current.BoundingRectangle.ToString())
    }
  }
  'clickpoint' {
    $hits = Find-SubtreeText $win $Needle
    if ($hits.Count -eq 0) { Write-Output "result: needle_not_found $Needle"; exit 3 }
    $e = $hits[0]
    $r = $e.Current.BoundingRectangle
    $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
    # window-relative client coords
    $wr = New-Object Win32Msg+RECT
    [Win32Msg]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
    $lx = $cx - $wr.L; $ly = $cy - $wr.T
    $lp = [IntPtr](($ly -shl 16) -bor ($lx -band 0xFFFF))
    # find Chromium render child
    $child = [Win32Msg]::FindWindowExW($hwnd, [IntPtr]::Zero, 'Chrome_RenderWidgetHostHWND', $null)
    $target = if ($child -ne [IntPtr]::Zero) { $child } else { $hwnd }
    [Win32Msg]::PostMessage($target, 0x0200, [UIntPtr]::Zero, $lp) | Out-Null   # WM_MOUSEMOVE
    Start-Sleep -Milliseconds 80
    [Win32Msg]::PostMessage($target, 0x0201, [UIntPtr]1, $lp) | Out-Null        # WM_LBUTTONDOWN
    Start-Sleep -Milliseconds 80
    [Win32Msg]::PostMessage($target, 0x0202, [UIntPtr]::Zero, $lp) | Out-Null   # WM_LBUTTONUP
    Write-Output "result: posted_click needle=[$($e.Current.Name)] screen=($cx,$cy) client=($lx,$ly) target=0x$($target.ToInt64().ToString('X'))"
  }
}

# additional mode appended: scrolldoc (UIA ScrollPattern on the web document)
if ($Mode -eq 'scrolldoc') {
  Add-Type -AssemblyName UIAutomationClient
  $condDoc = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Document)
  $docs = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condDoc)
  $done = $false
  foreach ($d in $docs) {
    try {
      $sp = $d.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
      for ($i = 0; $i -lt 8; $i++) { $sp.Scroll([System.Windows.Automation.ScrollAmount]::LargeIncrement, $true) ; Start-Sleep -Milliseconds 150 }
      $vi = $sp.Current.VerticalScrollPercent
      Write-Output "result: scrolldoc ok vertical=$vi on=[$($d.Current.Name)]"
      $done = $true
      break
    } catch { }
  }
  if (-not $done) { Write-Output 'result: no scrollable document found' ; exit 3 }
}

# additional mode appended: wheel (PostMessage WM_MOUSEWHEEL to Chromium render child)
if ($Mode -eq 'wheel') {
  $child = [Win32Msg]::FindWindowExW($hwnd, [IntPtr]::Zero, 'Chrome_RenderWidgetHostHWND', $null)
  $target = if ($child -ne [IntPtr]::Zero) { $child } else { $hwnd }
  $wr = New-Object Win32Msg+RECT
  [Win32Msg]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
  $x = [int](($wr.L + $wr.R) / 2); $y = [int](($wr.T + $wr.B) / 2)
  $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
  for ($i = 0; $i -lt 15; $i++) {
    $wp = [UIntPtr][uint32]4286578688 # 0xFF880000: delta -120 in high word
    [Win32Msg]::PostMessage($target, 0x020A, $wp, $lp) | Out-Null
    Start-Sleep -Milliseconds 100
  }
  Write-Output "result: wheel posted x15 to 0x$($target.ToInt64().ToString('X')) at ($x,$y)"
}
