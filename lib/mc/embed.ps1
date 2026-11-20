param(
  [Parameter(Mandatory=$true)][string]$Action,
  [string]$Title = "Minecraft",
  [int]$X = -3200,
  [int]$Y = 0,
  [int]$RestoreX = 120,
  [int]$RestoreY = 80
)

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class EmbedWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;

  public static IntPtr FindFuzzy(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string t = sb.ToString();
      if (t.Length > 0 && t.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = h; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

if (-not ('EmbedWin' -as [type])) {
  Add-Type -TypeDefinition $sig
}

$h = [EmbedWin]::FindFuzzy($Title)
if ($h -eq [IntPtr]::Zero) {
  Write-Output '{"ok":false,"error":"window not found"}'
  exit 0
}

$flagsNoMove = [EmbedWin]::SWP_NOSIZE -bor [EmbedWin]::SWP_NOZORDER -bor [EmbedWin]::SWP_NOACTIVATE
$flagsShow = [EmbedWin]::SWP_NOSIZE -bor [EmbedWin]::SWP_NOZORDER

switch ($Action.ToLower()) {
  'hide' {
    # 挪到屏幕左侧外面：不最小化（最小化后截图是黑屏），只是看不见
    [void][EmbedWin]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, 0, 0, $flagsNoMove)
    Write-Output ('{"ok":true,"action":"hide","x":' + $X + ',"y":' + $Y + '}')
  }
  'show' {
    [void][EmbedWin]::ShowWindow($h, 9)
    [void][EmbedWin]::SetWindowPos($h, [IntPtr]::Zero, $RestoreX, $RestoreY, 0, 0, $flagsShow)
    Write-Output ('{"ok":true,"action":"show","x":' + $RestoreX + ',"y":' + $RestoreY + '}')
  }
  'status' {
    Write-Output ('{"ok":true,"found":true}')
  }
  default {
    Write-Output '{"ok":false,"error":"unknown action"}'
  }
}
