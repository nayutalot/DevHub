param([int]$ProcId = 0, [int]$Steps = 10)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wc)
if (-not $win) { Write-Output 'result: window_not_found'; exit 2 }
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$i = 0
foreach ($e in $all) {
  $i++
  if ($i -gt 600) { break }
  try {
    $sp = $e.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    $c = $sp.Current
    Write-Output ("scrollable: [" + $e.Current.Name + "] ct=" + $e.Current.ControlType.ProgrammaticName + " v=" + $c.VerticalScrollPercent + "% vertScrollable=" + $c.VerticallyScrollable)
  } catch { }
}
Write-Output "total_elements_scanned=$i"
