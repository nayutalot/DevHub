# AC9 acceptance v2: open tray overflow, enumerate flyout windows/buttons, right-click DevHub icon,
# capture screenshot, enumerate #32768 menu items.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TrayClick9b {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
}
"@
[TrayClick9b]::SetProcessDPIAware() | Out-Null
$root = [System.Windows.Automation.AutomationElement]::RootElement
$btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)

# 1) click the chevron
$chevDone = $false
$deskChildren = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($c in $deskChildren) {
  try {
    $btns = $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    foreach ($b in $btns) {
      if ($b.Current.AutomationId -eq 'SystemTrayIcon' -and $b.Current.Name -like '显示隐藏的图标*') {
        $r = $b.Current.BoundingRectangle
        $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
        [TrayClick9b]::SetCursorPos($cx, $cy) | Out-Null
        Start-Sleep -Milliseconds 200
        [TrayClick9b]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [TrayClick9b]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Write-Host "chevron-clicked at ($cx,$cy)"
        $chevDone = $true
      }
    }
  } catch { }
  if ($chevDone) { break }
}
if (-not $chevDone) { Write-Host 'chevron-not-found'; exit 2 }
Start-Sleep -Milliseconds 2500

# 2) enumerate desktop children windows and all their buttons (find DevHub)
$script:dev = $null
$desk2 = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($c in $desk2) {
  $cn = $c.Current.ClassName
  try {
    $btns = $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    foreach ($b in $btns) {
      $nm = $b.Current.Name
      $aid = $b.Current.AutomationId
      if ($aid -in @('NotifyItemIcon', 'SystemTrayIcon') -or ($nm -match 'DevHub')) {
        $br = $b.Current.BoundingRectangle
        Write-Host ("icon: win=[" + $cn + "] autoId=[" + $aid + "] name=[" + ($nm -replace "`r`n", ' / ') + "] rect=" + [int]$br.X + "," + [int]$br.Y + "," + [int]$br.Width + "," + [int]$br.Height)
        if (-not $script:dev -and $nm -match 'DevHub') { $script:dev = $b }
      }
    }
  } catch { }
}
if (-not $script:dev) { Write-Host 'result: devhub-not-in-flyout'; exit 3 }

# 3) right-click it
$r = $script:dev.Current.BoundingRectangle
$cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
[TrayClick9b]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 300
[TrayClick9b]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 90
[TrayClick9b]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
Write-Host "rightclicked devhub tray at ($cx,$cy)"
Start-Sleep -Milliseconds 1800

# 4) full-screen screenshot (context menu popup)
$bmp = New-Object System.Drawing.Bitmap(2560, 1440)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save('F:\Active_Project\DevHub\acceptance\ac9-tray-menu.png', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host 'screenshot saved: acceptance/ac9-tray-menu.png'

# 5) enumerate #32768 menu items
$menuWins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32768')))
$idx = 0
foreach ($mw in $menuWins) {
  $items = $mw.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))
  foreach ($it in $items) {
    $ir = $it.Current.BoundingRectangle
    Write-Host ("menuitem[" + $idx + "]: name=[" + $it.Current.Name + "] rect=" + [int]$ir.X + "," + [int]$ir.Y + "," + [int]$ir.Width + "," + [int]$ir.Height + " enabled=" + $it.Current.IsEnabled)
    $idx++
  }
}
if ($idx -eq 0) { Write-Host 'result: no-menu-items-found' } else { Write-Host "result: $idx menu items" }
