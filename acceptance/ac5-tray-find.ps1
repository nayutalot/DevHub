# AC5 acceptance helper: locate the DevHub tray icon on the taskbar and report its rect.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
# search scopes: desktop children (taskbar + overflow windows)
$targets = @()
$deskChildren = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($c in $deskChildren) {
  try {
    $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $btns = $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    foreach ($b in $btns) {
      $n = $b.Current.Name
      if ($n -and $n -like '*DevHub*') {
        $r = $b.Current.BoundingRectangle
        Write-Output ("tray-candidate: [" + $n + "] class=[" + $c.Current.ClassName + "] rect=" + $r.X + "," + $r.Y + "," + $r.Width + "," + $r.Height)
        $targets += $b
      }
    }
  } catch { }
}
if ($targets.Count -eq 0) { Write-Output 'result: tray-icon-not-found'; exit 2 }
$e = $targets[0]
$rect = $e.Current.BoundingRectangle
$cx = [int]($rect.X + $rect.Width / 2); $cy = [int]($rect.Y + $rect.Height / 2)
Write-Output "result: tray center=($cx,$cy) name=[$($e.Current.Name)]"
