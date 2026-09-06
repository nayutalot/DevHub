# M3-C2 helper v3: atomic revoke — find row button, invoke, then click OK on the native confirm dialog
param(
  [int]$ProcId = 11376,
  [string]$RowNeedle = 'm3c2-standin-client'
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WDlg {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wc)
if (-not $win) { Write-Output 'result: window_not_found'; exit 2 }

# phase 1: locate row text + same-row button in one fresh pass
$els = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$targetY = $null
$buttons = New-Object System.Collections.ArrayList
foreach ($e in $els) {
  $n = $e.Current.Name
  if ($n -eq $RowNeedle -and $targetY -eq $null) {
    $r = $e.Current.BoundingRectangle
    $targetY = [int]$r.Y + [int]($r.Height / 2)
  }
  if ($n -like '*Revoke*' -and $e.Current.ControlType.ProgrammaticName -match 'Button') {
    $r = $e.Current.BoundingRectangle
    if ($r.Height -gt 0 -and $r.Width -gt 0) {
      [void]$buttons.Add([pscustomobject]@{ El = $e; Y = [int]$r.Y; H = [int]$r.Height })
    }
  }
}
if ($targetY -eq $null) { Write-Output 'result: row_text_not_found'; exit 3 }
$cands = $buttons | Where-Object { [math]::Abs(($_.Y + $_.H / 2) - $targetY) -lt 20 }
if ($cands.Count -eq 0) { Write-Output ("result: no_button_on_row y=" + $targetY); exit 4 }
$inv = ($cands | Select-Object -First 1).El.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$inv.Invoke()
Write-Output "row revoke invoked"

# phase 2: wait for the native confirm dialog and press OK
$deadline = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 400
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $wins) {
    $wpid = $w.Current.ProcessId
    $wname = $w.Current.Name
    if ($wpid -ne $ProcId) { continue }
    if ($wname -eq 'DevHub' -and $w.Current.ClassName -eq 'Chrome_WidgetWin_1') { continue }  # main window
    $okCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, 'OK')
    $okBtn = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $okCond)
    if ($okBtn -ne $null) {
      try {
        $okInv = $okBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $okInv.Invoke()
        Write-Output "confirm dialog OK invoked (dialog=[$wname])"
        exit 0
      } catch { }
    }
  }
}
Write-Output 'result: confirm_dialog_not_found'
exit 7
