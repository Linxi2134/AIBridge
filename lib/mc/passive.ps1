param(
  [string]$Title = "Minecraft",
  # on = 只看不点（不抢焦点、点击穿透）；off = 恢复正常可操作
  [string]$Mode = "on"
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PassiveWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);

  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr val);

  public const int GWL_EXSTYLE = -20;
  public const long WS_EX_TRANSPARENT = 0x00000020;   // 点击穿透
  public const long WS_EX_NOACTIVATE  = 0x08000000;   // 点击不夺焦点

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

  public static long SetPassive(IntPtr h, bool on) {
    long style = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
    if (on) {
      style |= WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
    } else {
      style &= ~(WS_EX_TRANSPARENT | WS_EX_NOACTIVATE);
    }
    SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(style));
    return style;
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

$h = [PassiveWin]::FindFuzzy($Title)
if ($h -eq [IntPtr]::Zero) {
  @{ ok = $false; error = "window not found" } | ConvertTo-Json -Compress
  exit 0
}

$style = [PassiveWin]::SetPassive($h, ($Mode -ne 'off'))
@{ ok = $true; mode = $Mode; style = ("0x{0:X}" -f $style) } | ConvertTo-Json -Compress
