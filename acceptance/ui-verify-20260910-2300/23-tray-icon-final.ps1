. (Join-Path $PSScriptRoot 'tray-uia-common.ps1')
# SAFE: UIA Invoke on chevron only (no mouse, no keys, no SetFocus). Open flyout, read
# DevHub icon name/rect, close flyout with a second chevron invoke.
if (-not (Open-TrayOverflow)) { Write-Output 'RESULT: CHEVRON-FAIL'; exit 2 }
$icon = Find-TrayIconDevHub
if ($null -eq $icon) { Write-Output 'RESULT: ICON-NOT-FOUND'; exit 3 }
$nm = $icon.Current.Name
$aid = $icon.Current.AutomationId
$r = $icon.Current.BoundingRectangle
Write-Output ("ICON-FOUND: name=[" + ($nm -replace "`r`n", ' / ') + "] autoId=[" + $aid + "] rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
Write-Output 'RESULT: TRAY-ICON-EXISTS'
# close the flyout (toggle chevron again)
$chev = $null
foreach ($c in $script:RootEl.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($c.Current.ClassName -ne 'Shell_TrayWnd') { continue }
  foreach ($b in $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $script:BtnCond)) {
    if ($b.Current.AutomationId -eq 'SystemTrayIcon' -and $b.Current.Name -like '显示隐藏的图标*') { $chev = $b; break }
  }
  if ($chev) { break }
}
if ($chev) {
  try { ($chev.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke(); Write-Output 'flyout closed (chevron re-invoke)' } catch { }
}
