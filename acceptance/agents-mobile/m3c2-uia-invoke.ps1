# M3-C2 helper: UIA Invoke (or Toggle) on element by name needle
param(
  [int]$ProcId = 37708,
  [string]$Needle = '',
  [int]$Index = 0
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wc)
if (-not $win) { Write-Output 'result: window_not_found'; exit 2 }
$els = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$hits = @()
foreach ($e in $els) {
  $n = $e.Current.Name
  if ($n -and $n -like ('*' + $Needle + '*')) { $hits += $e }
}
if ($hits.Count -eq 0) { Write-Output "result: needle_not_found $Needle"; exit 3 }
if ($Index -ge $hits.Count) { Write-Output "result: index_out_of_range total=$($hits.Count)"; exit 4 }
$e = $hits[$Index]
try {
  $inv = $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $inv.Invoke()
  Write-Output "result: invoked needle=[$($e.Current.Name)] type=[$($e.Current.ControlType.ProgrammaticName)]"
  exit 0
} catch {
  try {
    $tg = $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $tg.Toggle()
    Write-Output "result: toggled needle=[$($e.Current.Name)] type=[$($e.Current.ControlType.ProgrammaticName)]"
    exit 0
  } catch {
    Write-Output "result: no_invoke_or_toggle needle=[$($e.Current.Name)] err=$($_.Exception.Message)"
    exit 5
  }
}
