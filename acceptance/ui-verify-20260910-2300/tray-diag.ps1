. (Join-Path $PSScriptRoot 'lib.ps1')
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
Write-Output '=== desktop children (tray-related windows) ==='
foreach ($c in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  $cn = $c.Current.ClassName; $nm = $c.Current.Name
  if (($cn -match 'Shell_TrayWnd|TrayNotify|Overflow|Xaml|Flyout|Taskbar') -or ($nm -match '任务栏|Taskbar')) {
    $r = $c.Current.BoundingRectangle
    Write-Output ("win class=[" + $cn + "] name=[" + $nm + "] rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
  }
}
Write-Output '=== all buttons under Shell_TrayWnd-ish windows ==='
$btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
foreach ($c in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  $cn = $c.Current.ClassName
  if ($cn -match 'Shell_TrayWnd|TrayNotify|Xaml|Overflow|Taskbar' -or $cn -eq '') {
    try {
      foreach ($b in $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)) {
        $r = $b.Current.BoundingRectangle
        if ($r.X -le 0 -and $r.Y -le 0 -and $r.Width -eq 0) { continue }
        Write-Output ("btn class=[" + $cn + "] autoId=[" + $b.Current.AutomationId + "] name=[" + ($b.Current.Name -replace "`r`n", ' / ') + "] rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
      }
    } catch { }
  }
}
