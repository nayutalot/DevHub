param([string]$Exe,[string]$Probe,[string]$Prefix,[string]$Work)
Write-Output "GOT Probe=[$Probe] Exe-len=$($Exe.Length)"
Write-Output "INVOKING"
node $Probe $Exe $Prefix $Work
Write-Output "NODE-EXIT=$LASTEXITCODE"
