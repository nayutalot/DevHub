# tray-uia-common.ps1 — mouseless tray automation helpers (UIA Invoke/SetFocus + keybd).
# Safe under fullscreen game foreground: no cursor movement, no mouse buttons.
. (Join-Path $PSScriptRoot 'lib.ps1')
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KBX {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$script:RootEl = [System.Windows.Automation.AutomationElement]::RootElement
$script:BtnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$script:MenuCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32768')

function Send-Key([byte]$vk, [byte]$vk2 = 0) {
  if ($vk2 -ne 0) { [KBX]::keybd_event($vk2, 0, 0, [UIntPtr]::Zero) }
  [KBX]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [KBX]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
  if ($vk2 -ne 0) { [KBX]::keybd_event($vk2, 0, 2, [UIntPtr]::Zero) }
}

function Open-TrayOverflow {
  for ($try = 1; $try -le 3; $try++) {
    foreach ($c in $script:RootEl.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($c.Current.ClassName -ne 'Shell_TrayWnd') { continue }
      foreach ($b in $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $script:BtnCond)) {
        if ($b.Current.AutomationId -eq 'SystemTrayIcon' -and $b.Current.Name -like '显示隐藏的图标*') {
          try {
            ($b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
            Write-Output "chevron: UIA invoked (try $try)"
          } catch {
            Write-Output ("chevron: invoke failed: " + $_.Exception.Message)
            return $false
          }
          Start-Sleep -Milliseconds 2000
          return $true
        }
      }
    }
    Start-Sleep -Milliseconds 1200
  }
  Write-Output 'chevron: NOT-FOUND'
  return $false
}

function Find-TrayIconDevHub {
  foreach ($c in $script:RootEl.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $cn = $c.Current.ClassName
    if ($cn -eq 'Shell_TrayWnd' -or $cn -eq '#32768') { continue }
    foreach ($b in $c.FindAll([System.Windows.Automation.TreeScope]::Descendants, $script:BtnCond)) {
      $aid = $b.Current.AutomationId
      if ($aid -like 'Appid:*') { continue }
      $n = $b.Current.Name
      if ($n -and $n -match 'DevHub') { return $b }
    }
  }
  return $null
}

function Get-TrayMenuItems {
  # Electron 44 renders the tray menu via views::MenuRunner — the popup window ITSELF
  # is a DevHub-owned top-level window with ControlType=Menu (Chromium widget).
  $script:DevhubPids = @(Get-CimInstance Win32_Process -Filter "Name='DevHub.exe'" | Select-Object -ExpandProperty ProcessId)
  $menuType = [System.Windows.Automation.ControlType]::Menu
  $menuCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $menuType)
  $items = @()
  foreach ($w in $script:RootEl.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($script:DevhubPids -notcontains $w.Current.ProcessId) { continue }
    if ($w.Current.ControlType.ProgrammaticName -ne $menuType.ProgrammaticName) {
      # also accept a Menu as immediate child (defensive)
      if ($w.FindAll([System.Windows.Automation.TreeScope]::Children, $menuCond).Count -eq 0) { continue }
    }
    $found = @($w.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem))) | Where-Object { $_.Current.Name -ne '' -or $_.Current.AutomationId -ne '' })
    if ($found.Count -gt 0) {
      $script:MenuHost = $w
      $items += $found
    }
  }
  return ,$items
}

function Open-TrayContextMenu {
  # returns $true if context menu items were found
  if (-not (Open-TrayOverflow)) { return $null }
  $icon = Find-TrayIconDevHub
  if ($null -eq $icon) { Write-Output 'tray-icon: NOT-FOUND-IN-FLYOUT'; return $null }
  $r = $icon.Current.BoundingRectangle
  Write-Output ("tray-icon: name=[" + ($icon.Current.Name -replace "`r`n", ' / ') + "] rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
  try { $icon.SetFocus(); Write-Output 'icon: SetFocus ok' } catch { Write-Output ('icon: SetFocus failed: ' + $_.Exception.Message) }
  Start-Sleep -Milliseconds 400
  # Shift+F10 = context menu on focused element (keyboard only)
  Send-Key 0x14 0x7A
  Start-Sleep -Milliseconds 1500
  $items = Get-TrayMenuItems
  if ($items.Count -eq 0) {
    # fallback: VK_APPS menu key
    Send-Key 0x5D
    Start-Sleep -Milliseconds 1500
    $items = Get-TrayMenuItems
  }
  return $items
}

function Invoke-MenuItem($item) {
  try { ($item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke(); return $true } catch { }
  try { ($item.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)).DoDefaultAction(); return $true } catch { }
  return $false
}
