# AC5 acceptance helper v2: open tray overflow flyout, list icons, optionally right-click a named one.
param([string]$Target = '', [string]$Action = 'list')   # Action: list | rightclick
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TrayClick2 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
}
"@
[TrayClick2]::SetProcessDPIAware() | Out-Null
$script:Found = $null
$root = [System.Windows.Automation.AutomationElement]::RootElement
$btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)

function Find-InFlyout {
  $deskChildren = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($c in $deskChildren) {
    try {
      $btns = $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
      foreach ($b in $btns) {
        if ($b.Current.AutomationId -in @('NotifyItemIcon', 'SystemTrayIcon')) {
          $nm = $b.Current.Name -replace "`r`n", ' / '
          Write-Host ("icon: class=[" + $c.Current.ClassName + "] name=[" + $nm + "] autoId=[" + $b.Current.AutomationId + "]")
          if ($Target -ne '' -and $b.Current.Name -like ('*' + $Target + '*')) { $script:Found = $b }
        }
      }
    } catch { }
  }
}

# open the flyout via chevron (by name, else by known coords)
$chevronDone = $false
$deskChildren = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($c in $deskChildren) {
  try {
    $btns = $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    foreach ($b in $btns) {
      if ($b.Current.AutomationId -eq 'SystemTrayIcon' -and $b.Current.Name -like '显示隐藏的图标*') {
        $r = $b.Current.BoundingRectangle
        $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
        [TrayClick2]::SetCursorPos($cx, $cy) | Out-Null
        Start-Sleep -Milliseconds 150
        [TrayClick2]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [TrayClick2]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 1200
        Write-Host "chevron-clicked at ($cx,$cy)"
        $chevronDone = $true
      }
    }
  } catch { }
}
if (-not $chevronDone) {
  Write-Host 'chevron-not-found-by-name, trying coords (2170,1410)'
  [TrayClick2]::SetCursorPos(2170, 1410) | Out-Null
  Start-Sleep -Milliseconds 150
  [TrayClick2]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [TrayClick2]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 1200
}

Find-InFlyout
if ($Action -eq 'rightclick') {
  if (-not $script:Found) { Write-Output "result: target-not-found $Target"; exit 3 }
  $r = $script:Found.Current.BoundingRectangle
  $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
  [TrayClick2]::SetCursorPos($cx, $cy) | Out-Null
  Start-Sleep -Milliseconds 200
  [TrayClick2]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [TrayClick2]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
  Write-Output "result: rightclicked target at ($cx,$cy)"
} else {
  Write-Output 'result: listed'
}
