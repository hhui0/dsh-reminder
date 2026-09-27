# dsh-reminder window activator: bring the DSH main window to the front when a reminder fires.
#
# Why this exists: DSH gives plugins no API to control its own window (the host half is a plain
# Node child process, the client half runs in the renderer), so it is done from outside with Win32.
# This script needs nothing but the .NET user32 interop that ships with Windows.
#
# It deliberately does NOT resize or move the window, and keeps no state: a reminder only has to
# make DSH visible and focused, because the popup and its sound are produced inside the page.
# Copied from dsh-voice's tested activator (same author, same problem) rather than rewritten:
# the branches below each record a defect that was measured on this machine, and a fresh
# implementation would only rediscover them one at a time.
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 decodes a .ps1 without a UTF-8 BOM as ANSI, so
# any non-ASCII character turns into mojibake and breaks the parse (it did, twice).
#
# Usage:
#   dsh-window.ps1 -Action activate
#   dsh-window.ps1 -Action status
param(
  [Parameter(Mandatory = $true)][ValidateSet('activate', 'status')][string]$Action
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class DshWin {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
  }
}
"@

$SW_SHOW = 5
$SW_RESTORE = 9
$SW_MAXIMIZE = 3
$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$VK_MENU = [byte]0x12
$KEYEVENTF_KEYUP = [uint32]2
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004

# UI Automation ships with Windows. The app's own taskbar button is the only outside handle on
# "let the app show its own window", which is the one thing that actually works for a hidden one.
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue

# The biggest window owned by a DSH process is the main one; the process also owns hidden helper
# windows (a 1440x753 one showed up while testing). A visible window is preferred, but one hidden
# to the tray or minimised is still the window to bring forward, so visibility is only a preference.
function Get-DshWindow {
  $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DeepSeek|Harness' }
  if ($null -eq $procs) { return [IntPtr]::Zero }
  $pids = @($procs | Select-Object -ExpandProperty Id)
  $script:pidCount = $pids.Count
  # The taskbar button is labelled with the process name; remember it for Invoke-TaskbarButton.
  $script:procName = @($procs | Select-Object -ExpandProperty ProcessName)[0]
  $script:seen = 0
  $script:visibleBest = [IntPtr]::Zero
  $script:visibleArea = 0
  $script:anyBest = [IntPtr]::Zero
  $script:anyArea = 0
  $callback = [DshWin+EnumProc]{
    param($hWnd, $lParam)
    $owner = 0
    [void][DshWin]::GetWindowThreadProcessId($hWnd, [ref]$owner)
    if ($pids -contains [int]$owner) {
      $rect = New-Object DshWin+RECT
      [void][DshWin]::GetWindowRect($hWnd, [ref]$rect)
      $area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)
      if ($area -le 0) { return $true }
      $script:seen += 1
      if ($area -gt $script:anyArea) { $script:anyArea = $area; $script:anyBest = $hWnd }
      if ([DshWin]::IsWindowVisible($hWnd) -and $area -gt $script:visibleArea) {
        $script:visibleArea = $area
        $script:visibleBest = $hWnd
      }
    }
    return $true
  }
  [void][DshWin]::EnumWindows($callback, [IntPtr]::Zero)
  if ($script:visibleBest -ne [IntPtr]::Zero) { return $script:visibleBest }
  return $script:anyBest
}

function Get-RectOf([IntPtr]$hWnd) {
  $rect = New-Object DshWin+RECT
  [void][DshWin]::GetWindowRect($hWnd, [ref]$rect)
  return "$($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top)@($($rect.Left),$($rect.Top))"
}

function New-Placement {
  $placement = New-Object DshWin+WINDOWPLACEMENT
  $placement.length = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DshWin+WINDOWPLACEMENT])
  return $placement
}

# Click the app's own taskbar button, i.e. do what the user does to get a tray-hidden window back.
#
# This is not an aesthetic choice. Showing the window from outside with ShowWindow makes it visible,
# but Electron never learns that the window is back: the renderer stays suspended, so the window
# paints its last frame and swallows every click. Measured: `foreground=True`, `hung=False`, and
# still nothing responds. Having the app show itself is the only path that restores input.
#
# The UIA Invoke pattern is not supported by taskbar buttons, so the click is synthesised at the
# button's centre - and the pointer is put back where it was, since the user did not move it.
function Invoke-TaskbarButton([string]$ProcessName) {
  if ([string]::IsNullOrEmpty($ProcessName)) { return $false }
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $true_ = [System.Windows.Automation.Condition]::TrueCondition
    foreach ($class in @('Shell_TrayWnd', 'Shell_SecondaryTrayWnd')) {
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $class)
      $tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
      if ($null -eq $tray) { continue }
      foreach ($element in $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $true_)) {
        try {
          if ($element.Current.ClassName -ne 'Taskbar.TaskListButtonAutomationPeer') { continue }
          if ($element.Current.Name -notlike "$ProcessName*") { continue }
          $rect = $element.Current.BoundingRectangle
          if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
          $x = [int]($rect.X + $rect.Width / 2)
          $y = [int]($rect.Y + $rect.Height / 2)
          $origin = New-Object DshWin+POINT
          [void][DshWin]::GetCursorPos([ref]$origin)
          [void][DshWin]::SetCursorPos($x, $y)
          Start-Sleep -Milliseconds 120
          [DshWin]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 60
          [DshWin]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 120
          [void][DshWin]::SetCursorPos($origin.X, $origin.Y)
          return $true
        } catch {
          continue
        }
      }
    }
  } catch {
    return $false
  }
  return $false
}

$hwnd = Get-DshWindow

if ($Action -eq 'status') {
  if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'window=missing'; exit 1 }
  Write-Output "window=$hwnd rect=$(Get-RectOf $hwnd) visible=$([DshWin]::IsWindowVisible($hwnd)) iconic=$([DshWin]::IsIconic($hwnd))"
  exit 0
}

if ($hwnd -eq [IntPtr]::Zero) {
  # Say what was actually seen, so a failure is diagnosable from the host's log alone.
  Write-Error "DSH main window not found (processes=$($script:pidCount) windows=$($script:seen))"
  exit 2
}

# A window hidden to the tray is not merely invisible: Electron suspends the renderer behind it,
# so showing the native window is not enough - it has to come back *activated*, or it paints its
# last frame and swallows every click ("the window is there, and nothing responds").
#
# Which call matters. SW_SHOW activates without touching the size or position, so a maximized
# window stays maximized (SW_RESTORE shrinks it to its normal bounds - measured: 1936x1048 became
# 1296x828). A minimised window does need SW_RESTORE, so the maximized state is read first and put
# back afterwards.
$placement = New-Placement
[void][DshWin]::GetWindowPlacement($hwnd, [ref]$placement)
$wasMaximized = ($placement.showCmd -eq $SW_MAXIMIZE)
$script:taskbarClick = $false
if (-not [DshWin]::IsWindowVisible($hwnd)) {
  # Hidden to the tray: only the app showing itself brings the renderer back (see the note on
  # Invoke-TaskbarButton). ShowWindow is kept purely as a last resort so the window is at least
  # on screen when the taskbar button cannot be found.
  $script:taskbarClick = Invoke-TaskbarButton $script:procName
  Start-Sleep -Milliseconds 900
  if (-not [DshWin]::IsWindowVisible($hwnd)) {
    [void][DshWin]::ShowWindowAsync($hwnd, $SW_SHOW)
    Start-Sleep -Milliseconds 250
  }
}
if ([DshWin]::IsIconic($hwnd)) {
  [void][DshWin]::ShowWindowAsync($hwnd, $SW_RESTORE)
  Start-Sleep -Milliseconds 250
  if ($wasMaximized) {
    [void][DshWin]::ShowWindow($hwnd, $SW_MAXIMIZE)
    Start-Sleep -Milliseconds 200
  }
}
if (-not [DshWin]::IsWindowVisible($hwnd)) {
  # The synchronous call is refused while the target's message loop is busy; the async one held up.
  [void][DshWin]::ShowWindowAsync($hwnd, $SW_SHOW)
  Start-Sleep -Milliseconds 200
}
# Getting the window in front, without touching the input queues.
#
# `SetForegroundWindow` alone is refused while another process owns the foreground (measured: the
# window came back visible but stayed behind whatever was in front). Two things are done about it:
# a momentary topmost flip, which lifts it above everything regardless of the foreground rules, and
# `BringWindowToTop`, which only changes the z-order.
#
# An earlier version also called AttachThreadInput to force the handover. Removed: attaching two
# threads' input queues changes focus behaviour for as long as it lasts, and a window that ends up
# in front but cannot take input is far worse than one that just needs a click.
[void][DshWin]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE))
Start-Sleep -Milliseconds 120
[void][DshWin]::SetWindowPos($hwnd, $HWND_NOTOPMOST, 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE))
[void][DshWin]::BringWindowToTop($hwnd)
[void][DshWin]::SetForegroundWindow($hwnd)

# The foreground lock refuses the handover unless the process owning the foreground has just
# received input itself. Tapping ALT makes that true, which is the standard way to get the call
# accepted; without it the window can sit in front yet never become the *active* window - and an
# inactive window is exactly the "visible but nothing responds" case.
if (([DshWin]::GetForegroundWindow()) -ne $hwnd) {
  [void][DshWin]::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
  [void][DshWin]::keybd_event($VK_MENU, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [void][DshWin]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 150
}
Write-Output "activated rect=$(Get-RectOf $hwnd) visible=$([DshWin]::IsWindowVisible($hwnd)) iconic=$([DshWin]::IsIconic($hwnd)) foreground=$(([DshWin]::GetForegroundWindow()) -eq $hwnd) hung=$([DshWin]::IsHungAppWindow($hwnd)) taskbarClick=$($script:taskbarClick)"
exit 0
