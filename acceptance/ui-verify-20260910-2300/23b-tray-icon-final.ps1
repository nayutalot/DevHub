. (Join-Path $PSScriptRoot 'tray-uia-common.ps1')
for ($round = 1; $round -le 3; $round++) {
  if (-not (Open-TrayOverflow)) { Write-Output 'RESULT: CHEVRON-FAIL'; exit 2 }
  for ($wait = 0; $wait -lt 6; $wait++) {
    $icon = Find-TrayIconDevHub
    if ($null -ne $icon) {
      $nm = $icon.Current.Name
      $r = $icon.Current.BoundingRectangle
      Write-Output ("round=$round ICON-FOUND: name=[" + ($nm -replace "`r`n", ' / ') + "] autoId=[" + $icon.Current.AutomationId + "] rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
      Write-Output 'RESULT: TRAY-ICON-EXISTS'
      exit 0
    }
    Start-Sleep -Milliseconds 700
  }
  Write-Output ("round=$round icon not found; toggling chevron and retrying")
}
Write-Output 'RESULT: ICON-NOT-FOUND'
