. './lib.ps1'
Write-Output '=== DevHub windows (post-restart#1) ==='
Get-DevHubWindows | Format-Table Hwnd, Pid, X, Y, W, H, Title -AutoSize | Out-String -Width 200
