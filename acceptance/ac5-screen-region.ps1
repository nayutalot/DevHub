param([int]$X = 1900, [int]$Y = 1300, [int]$W = 660, [int]$H = 140, [string]$OutPath = 'F:\Active_Project\DevHub\acceptance\ac5-tray-area.png')
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ScrCap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[ScrCap]::SetProcessDPIAware() | Out-Null
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))
$g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "result: saved=$OutPath region=($X,$Y,$W,$H)"
