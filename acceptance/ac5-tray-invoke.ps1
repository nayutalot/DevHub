# AC5 acceptance helper v3: open tray overflow via UIA Invoke on chevron; find DevHub tray icon; optional invoke.
param([switch]$InvokeDevHub)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)

# 1) chevron invoke
$deskChildren = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$chev = $null
foreach ($c in $deskChildren) {
  try {
    $btns = $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    foreach ($b in $btns) {
      if ($b.Current.AutomationId -eq 'SystemTrayIcon' -and $b.Current.Name -like '显示隐藏的图标*') { $chev = $b; break }
    }
  } catch { }
  if ($chev) { break }
}
if (-not $chev) { Write-Output 'result: chevron-not-found'; exit 2 }
try {
  ($chev.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
  Write-Output 'chevron: invoked (UIA)'
} catch {
  Write-Output ("chevron: invoke unavailable: " + $_.Exception.Message)
}
Start-Sleep -Milliseconds 1500

# 2) enumerate candidate flyout windows and their buttons
$script:dev = $null
$deskChildren2 = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($c in $deskChildren2) {
  $cn = $c.Current.ClassName
  if ($cn -match 'NotifyIconOverflow|XamlIsland|Overflow|Taskbar' -or $cn -eq '') {
    try {
      $btns = $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
      foreach ($b in $btns) {
        $n = $b.Current.Name
        if ($n -and $n -match 'DevHub|Electron|Agents') {
          $r = $b.Current.BoundingRectangle
          Write-Output ("candidate: win=[" + $cn + "] name=[" + ($n -replace "`r`n", ' / ') + "] autoId=[" + $b.Current.AutomationId + "] rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
          if (-not $script:dev) { $script:dev = $b }
        }
      }
    } catch { }
  }
}
if (-not $script:dev) { Write-Output 'result: devhub-tray-icon-not-visible'; exit 3 }

# 3) optional invoke
if ($InvokeDevHub) {
  try {
    $pats = $script:dev.GetSupportedPatterns()
    $inv = $script:dev.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $inv.Invoke()
    Write-Output 'result: devhub-tray-invoked'
  } catch {
    Write-Output ("result: devhub-tray-invoke-failed: " + $_.Exception.Message)
  }
} else {
  Write-Output 'result: devhub-tray-icon-found'
}
