. (Join-Path $PSScriptRoot 'tray-uia-common.ps1')
$items = Open-TrayContextMenu
if ($null -eq $items) { Write-Output 'RESULT: TRAY-PATH-FAILED'; exit 2 }
if ($items.Count -eq 0) { Write-Output 'RESULT: NO-MENU-ITEMS'; exit 3 }
for ($i = 0; $i -lt $items.Count; $i++) {
  $it = $items[$i]
  $ir = $it.Current.BoundingRectangle
  $ts = ''
  try { $ts = ' toggle=' + ($it.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState } catch { }
  Write-Output ("menuitem[" + $i + "]: name=[" + $it.Current.Name + "] enabled=" + $it.Current.IsEnabled + $ts + " rect=" + [int]$ir.X + "," + [int]$ir.Y + "," + [int]$ir.Width + "," + [int]$ir.Height)
}
Send-Key 0x1B
Write-Output ("RESULT: TRAY-MENU-OPEN-OK items=" + $items.Count)
