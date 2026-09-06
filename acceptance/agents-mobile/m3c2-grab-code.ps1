# M3-C2 helper v3: extract the 8-char pairing code adjacent to the TTL hint text (ASCII anchor)
param(
  [int]$ProcId = 37708,
  [string]$OutFile = "$env:TEMP\m3c2_pairing_code.txt"
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wc)
if (-not $win) { Write-Output 'result: window_not_found'; exit 2 }
$els = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$ttlRect = $null
$cands = @()
foreach ($e in $els) {
  $n = $e.Current.Name
  if (-not $n) { continue }
  if ($ttlRect -eq $null -and $n -match '^TTL') { $ttlRect = $e.Current.BoundingRectangle; continue }
  if ($n -match '^[0-9A-Z]{8}$' -and $n -notmatch '^[0-9]+$' -and $n -notmatch '[ILOU]') {
    $r = $e.Current.BoundingRectangle
    $cands += [pscustomobject]@{ Name = $n; X = [int]$r.X; Y = [int]$r.Y; H = [int]$r.Height }
  }
}
if ($ttlRect -eq $null) { Write-Output 'result: ttl_hint_not_found'; exit 3 }
$near = $cands | Where-Object { [math]::Abs($_.Y - $ttlRect.Y) -lt 40 -and $_.X -lt $ttlRect.X } | Sort-Object -Unique -Property Name
if ($near.Count -eq 0) { Write-Output 'result: code_not_near_ttl'; exit 4 }
if ($near.Count -gt 1) { Write-Output ("result: ambiguous count=" + $near.Count); exit 5 }
[System.IO.File]::WriteAllText($OutFile, $near[0].Name)
Write-Output ("result: code_captured len=" + $near[0].Name.Length + " at=(" + $near[0].X + "," + $near[0].Y + ") ttlY=" + [int]$ttlRect.Y + " file=" + $OutFile)
