Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$deskChildren = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($c in $deskChildren) {
  $cn = $c.Current.ClassName
  if ($cn -match 'Shell_TrayWnd|NotifyIconOverflowWindow|SystemTray' -or $c.Current.Name -match '通知|notification') {
    Write-Output ("window: class=[" + $cn + "] name=[" + $c.Current.Name + "]")
    $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $btns = $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    foreach ($b in $btns) {
      $r = $b.Current.BoundingRectangle
      Write-Output ("  btn: name=[" + $b.Current.Name + "] autoId=[" + $b.Current.AutomationId + "] rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
    }
  }
}
