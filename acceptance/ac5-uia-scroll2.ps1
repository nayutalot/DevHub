param([int]$ProcId = 0, [int]$Steps = 8, [int]$Dir = 1)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wc)
if (-not $win) { Write-Output 'result: window_not_found'; exit 2 }
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$amt = [System.Windows.Automation.ScrollAmount]::LargeIncrement
if ($Dir -lt 0) { $amt = [System.Windows.Automation.ScrollAmount]::LargeDecrement }
foreach ($e in $all) {
  try {
    $sp = $e.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    if (-not $sp.Current.VerticallyScrollable) { continue }
    for ($i = 0; $i -lt $Steps; $i++) { $sp.Scroll($amt, $false); Start-Sleep -Milliseconds 120 }
    Write-Output ("scrolled: [" + $e.Current.Name + "] now v=" + $sp.Current.VerticalScrollPercent + "%")
    exit 0
  } catch { }
}
Write-Output 'result: no scrollable group'
exit 3
