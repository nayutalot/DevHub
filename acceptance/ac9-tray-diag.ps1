# AC9 diagnostic: enumerate all tray-related buttons visible via UIA.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$desk = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$count = 0
foreach ($c in $desk) {
  try {
    $btns = $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    foreach ($b in $btns) {
      $aid = $b.Current.AutomationId
      if ($aid -match 'Tray|Notify|Icon') {
        $r = $b.Current.BoundingRectangle
        $nm = $b.Current.Name -replace "`r`n", ' / '
        Write-Host ("class=[" + $c.Current.ClassName + "] autoId=[" + $aid + "] name=[" + $nm + "] rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
        $count++
      }
    }
  } catch { }
}
Write-Host "total=$count"
