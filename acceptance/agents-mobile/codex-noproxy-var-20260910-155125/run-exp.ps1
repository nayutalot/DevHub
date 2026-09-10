# NO_PROXY discriminator experiment runner (ASCII only; PS 5.1 misparses BOM-less UTF-8 with CJK comments)
# Usage: powershell -NoProfile -File run-exp.ps1 -Exe <codex.exe> -Probe <probe.mjs> -Prefix <outPrefix> -Work <workCwd>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Probe,
  [Parameter(Mandatory = $true)][string]$Prefix,
  [Parameter(Mandatory = $true)][string]$Work
)

$ErrorActionPreference = 'Continue'

# 1) Explicitly clear proxy env vars (Windows env keys are case-insensitive)
foreach ($name in @('NO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
  Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
}

# 2) Assert parent process (source of node's inherited env) has no proxy keys
$remaining = Get-ChildItem Env: | Where-Object { $_.Name -match '^(NO_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$' }
if ($remaining) {
  Write-Output "parent-env-assert: FAIL remaining=$($remaining.Name -join ',')"
} else {
  Write-Output "parent-env-assert: PASS no NO_PROXY/HTTP_PROXY/HTTPS_PROXY/ALL_PROXY"
}

# 3) Run probe (probe asserts child env itself; writes timeline + stdout.jsonl + stderr.log)
node $Probe $Exe $Prefix $Work
