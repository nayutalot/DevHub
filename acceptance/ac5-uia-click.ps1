# AC5 acceptance helper: invoke a named button inside the DevHub window via UIA.
param(
  [int]$ProcId = 0,
  [string]$BtnName = 'Agents',
  [switch]$ListButtons,
  [switch]$ListTexts
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($ProcId -gt 0) {
  $wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wc)
}
if (-not $win) { Write-Output 'result: window_not_found'; exit 2 }
if ($ListButtons -or $ListTexts) {
  $ct = [System.Windows.Automation.ControlType]::Button
  if ($ListTexts) { $ct = [System.Windows.Automation.ControlType]::Text }
  $bc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
  $els = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bc)
  foreach ($e in $els) { Write-Output ('el: [' + $e.Current.Name + ']') }
  exit 0
}
$bc = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $BtnName)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))
)
$btn = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $bc)
if (-not $btn) { Write-Output "result: button_not_found $BtnName"; exit 3 }
$invoke = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
Write-Output "result: invoked $BtnName"
