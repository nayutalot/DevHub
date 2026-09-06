# M3-C2 helper: UIA dump of all elements (name + type + rect) for DevHub window
param(
  [int]$ProcId = 37708,
  [int]$MaxList = 300
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wc)
if (-not $win) { Write-Output 'result: window_not_found'; exit 2 }
$els = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$i = 0
foreach ($e in $els) {
  $n = $e.Current.Name
  $t = $e.Current.ControlType.ProgrammaticName
  $r = $e.Current.BoundingRectangle
  if (-not [string]::IsNullOrEmpty($n)) {
    Write-Output ("el: [" + $t + "] '" + $n + "' rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "x" + [int]$r.Height)
  }
  $i++
  if ($i -ge $MaxList) { break }
}
Write-Output "result: dumped=$i"
