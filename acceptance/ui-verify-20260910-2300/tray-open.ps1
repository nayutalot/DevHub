# tray-open.ps1 — open tray overflow, verify DevHub icon, right-click, enumerate menu, region screenshot.
. (Join-Path $PSScriptRoot 'lib.ps1')
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$EV = $PSScriptRoot

$root = [System.Windows.Automation.AutomationElement]::RootElement
$btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)

# 1) chevron: UIA first, fallback to ac9-precedent hardcoded physical click (2162,1410)
$chev = $null
try {
  $deskChildren = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($c in $deskChildren) {
    if ($c.Current.ClassName -ne 'Shell_TrayWnd') { continue }
    foreach ($b in $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)) {
      if ($b.Current.AutomationId -eq 'SystemTrayIcon' -and $b.Current.Name -like '显示隐藏的图标*') { $chev = $b; break }
    }
    if ($chev) { break }
  }
} catch { }
if ($chev) {
  try { ($chev.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() } catch {
    $r0 = $chev.Current.BoundingRectangle
    Invoke-Click ([int]($r0.X + $r0.Width / 2)) ([int]($r0.Y + $r0.Height / 2))
  }
  Write-Output 'chevron: UIA invoke'
} else {
  Write-Output 'chevron: UIA not found - clicking ac9 coordinate (2162,1410)'
  Invoke-Click 2162 1410
}
Start-Sleep -Milliseconds 2000

# 2) find DevHub tray icon in overflow flyout (exclude taskbar itself)
$script:dev = $null
foreach ($c in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  $cn = $c.Current.ClassName
  if ($cn -eq 'Shell_TrayWnd') { continue }
  try {
    foreach ($b in $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)) {
      $n = $b.Current.Name
      $aid = $b.Current.AutomationId
      if ($aid -like 'Appid:*') { continue }
      if ($n -and $n -match 'DevHub') {
        $r = $b.Current.BoundingRectangle
        Write-Output ("flyout-host=[" + $cn + "] tray-icon: name=[" + ($n -replace "`r`n", ' / ') + "] autoId=[" + $aid + "] rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
        if (-not $script:dev) { $script:dev = $b }
      }
    }
  } catch { }
}
if (-not $script:dev) {
  Write-Output 'DEBUG: flyout buttons dump (non-taskbar windows):'
  foreach ($c in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $cn = $c.Current.ClassName
    if ($cn -eq 'Shell_TrayWnd' -or $cn -eq '#32768') { continue }
    try {
      foreach ($b in $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)) {
        $r = $b.Current.BoundingRectangle
        if ($r.Width -le 0) { continue }
        Write-Output ("  dbg host=[" + $cn + "] autoId=[" + $b.Current.AutomationId + "] name=[" + ($b.Current.Name -replace "`r`n", ' / ') + "] rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
      }
    } catch { }
  }
  Write-Output 'RESULT: DEVHUB-TRAY-ICON-NOT-FOUND'; exit 3
}
Write-Output 'ICON-EXISTS: yes'

# 3) right-click -> context menu
$r = $script:dev.Current.BoundingRectangle
$cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
Move-Mouse $cx $cy
Start-Sleep -Milliseconds 300
Invoke-RightDown
Start-Sleep -Milliseconds 90
Invoke-RightUp
Write-Output "right-clicked tray icon at ($cx,$cy)"
Start-Sleep -Milliseconds 1800

# 4) enumerate #32768 menu items
$menuRect = $null
$menuWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32768')))
$idx = 0
foreach ($mw in $menuWins) {
  $mr = $mw.Current.BoundingRectangle
  Write-Output ("menu-window rect=" + [int]$mr.X + "," + [int]$mr.Y + "," + [int]$mr.Width + "," + [int]$mr.Height)
  if ($null -eq $menuRect) { $menuRect = $mr }
  foreach ($it in $mw.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))) {
    $ir = $it.Current.BoundingRectangle
    $ts = ''
    try { $tp = $it.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $ts = ' toggle=' + $tp.Current.ToggleState } catch { }
    Write-Output ("menuitem[" + $idx + "]: name=[" + $it.Current.Name + "] rect=" + [int]$ir.X + "," + [int]$ir.Y + "," + [int]$ir.Width + "," + [int]$ir.Height + " enabled=" + $it.Current.IsEnabled + $ts)
    $idx++
  }
}
if ($idx -eq 0) { Write-Output 'RESULT: NO-MENU-ITEMS'; exit 4 }
Write-Output "MENU-OPEN: yes ($idx items)"

# 5) region screenshot around menu (avoid full screen)
if ($menuRect) {
  $mx = [int]$menuRect.X - 20; $my = [int]$menuRect.Y - 20
  $mw2 = [int]$menuRect.Width + 40; $mh2 = [int]$menuRect.Height + 40
  Save-RegionShot $mx $my $mw2 $mh2 (Join-Path $EV '20-tray-menu.png')
}
# close menu with ESC to leave clean state
Send-Esc
Write-Output 'RESULT: TRAY-OPEN-OK'
