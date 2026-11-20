param(
  # 把游戏窗口摆到主区域、AIBridge 小窗置顶放右边
  [string]$GameTitle = "Minecraft",
  [string]$ChatTitle = "AIBridge 聊天",
  [switch]$Restore
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ArrangeWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

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
Add-Type -TypeDefinition $sig -Language CSharp

Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$game = [ArrangeWin]::FindFuzzy($GameTitle)
$chat = [ArrangeWin]::FindFuzzy($ChatTitle)

$result = @{ ok = $true; game = $false; chat = $false; screen = "$($wa.Width)x$($wa.Height)" }

if ($game -ne [IntPtr]::Zero) {
  [ArrangeWin]::ShowWindow($game, 9) | Out-Null      # SW_RESTORE
  if ($Restore) {
    [ArrangeWin]::SetWindowPos($game, [IntPtr]::Zero, 80, 60, 1280, 760, [ArrangeWin]::SWP_NOZORDER) | Out-Null
  } else {
    # 左边留给游戏，占 3/4 宽；右边留给聊天窗
    $w = [int]($wa.Width * 0.72)
    $h = $wa.Height - 40
    [ArrangeWin]::SetWindowPos($game, [IntPtr]::Zero, 0, 0, $w, $h, [ArrangeWin]::SWP_NOZORDER) | Out-Null
  }
  $result.game = $true
}

if ($chat -ne [IntPtr]::Zero) {
  [ArrangeWin]::ShowWindow($chat, 9) | Out-Null
  $cw = 400
  $ch = [int]($wa.Height * 0.62)
  $cx = $wa.Width - $cw - 8
  $cy = 8
  # 置顶：游戏全屏也不会盖住聊天窗
  [ArrangeWin]::SetWindowPos($chat, [ArrangeWin]::HWND_TOPMOST, $cx, $cy, $cw, $ch, [ArrangeWin]::SWP_NOACTIVATE) | Out-Null
  $result.chat = $true
}

$result | ConvertTo-Json -Compress
