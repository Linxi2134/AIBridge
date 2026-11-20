param(
  [Parameter(Mandatory=$true)][string]$Action,
  [int]$X = -999999,
  [int]$Y = -999999,
  [string]$Key = "",
  [string]$Title = ""
)

$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Act {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  public struct POINT { public int X; public int Y; }

  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint KEYUP = 0x0002;

  // Post click directly to the window: does NOT move the system cursor,
  // so the AI never steals the user's mouse.
  public static bool PostClick(IntPtr h, int screenX, int screenY) {
    if (h == IntPtr.Zero) return false;
    POINT p = new POINT();
    p.X = screenX;
    p.Y = screenY;
    if (!ScreenToClient(h, ref p)) return false;

    IntPtr lp = (IntPtr)((p.Y << 16) | (p.X & 0xFFFF));
    PostMessage(h, 0x0200, IntPtr.Zero, lp);        // WM_MOUSEMOVE
    System.Threading.Thread.Sleep(60);
    PostMessage(h, 0x0201, (IntPtr)1, lp);          // WM_LBUTTONDOWN
    System.Threading.Thread.Sleep(70);
    PostMessage(h, 0x0202, IntPtr.Zero, lp);        // WM_LBUTTONUP
    return true;
  }

  public static IntPtr FindByTitle(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string t = sb.ToString();
      // fuzzy match: real titles look like "Minecraft 26.3 - Singleplayer"
      if (t.Length > 0 && t.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = h; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

if (-not ('Win32Act' -as [type])) {
  Add-Type -TypeDefinition $sig
}

function ConvertTo-VK([string]$k) {
  if ($k -eq '') { return 0 }
  $u = $k.ToUpper()
  $map = @{
    'SPACE' = 0x20; 'ENTER' = 0x0D; 'ESC' = 0x1B; 'ESCAPE' = 0x1B; 'TAB' = 0x09
    'SHIFT' = 0x10; 'CTRL' = 0x11; 'ALT' = 0x12
    'UP' = 0x26; 'DOWN' = 0x28; 'LEFT' = 0x25; 'RIGHT' = 0x27
    'F1' = 0x70; 'F2' = 0x71; 'F3' = 0x72; 'F4' = 0x73; 'F5' = 0x74
    'E' = 0x45; 'Q' = 0x51; 'W' = 0x57; 'A' = 0x41; 'S' = 0x53; 'D' = 0x44
    'R' = 0x52; 'F' = 0x46; 'Z' = 0x5A; 'X' = 0x58; 'C' = 0x43; 'V' = 0x56
    'M' = 0x4D; 'B' = 0x42; 'T' = 0x54; 'G' = 0x47; 'H' = 0x48
  }
  if ($map.ContainsKey($u)) { return $map[$u] }
  if ($u.Length -eq 1) {
    $c = [int][char]$u
    if ($c -ge 48 -and $c -le 90) { return $c }
  }
  return 0
}

$rnd = New-Object System.Random

# F9 = emergency stop. Checked before every action; if pressed, abort and let caller stop the loop.
if (([Win32Act]::GetAsyncKeyState(0x78) -band 0x8000) -ne 0) {
  Write-Output '{"ok":false,"error":"user aborted"}'
  exit 0
}

try {
  switch ($Action.ToLower()) {
    'move' {
      if ($X -eq -999999 -or $Y -eq -999999) { Write-Output '{"ok":false,"error":"need x,y"}'; exit 0 }
      [void][Win32Act]::SetCursorPos($X, $Y)
      Write-Output ('{"ok":true,"action":"move","x":' + $X + ',"y":' + $Y + '}')
    }
    'click' {
      if ($X -eq -999999 -or $Y -eq -999999) { Write-Output '{"ok":false,"error":"need x,y"}'; exit 0 }
      # 借用光标：记下原位 → 移过去点一下 → 立刻还回去。
      # 用户只会看到光标闪一下，不会一直停在别处。
      $orig = [Win32Act+POINT]::new()
      [void][Win32Act]::GetCursorPos([ref]$orig)

      [void][Win32Act]::SetCursorPos($X, $Y)
      Start-Sleep -Milliseconds (25 + $rnd.Next(0, 30))
      [Win32Act]::mouse_event([Win32Act]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds (40 + $rnd.Next(0, 50))
      [Win32Act]::mouse_event([Win32Act]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 30

      if ($orig.X -ne 0 -or $orig.Y -ne 0) {
        [void][Win32Act]::SetCursorPos($orig.X, $orig.Y)
      }
      Write-Output ('{"ok":true,"action":"click","x":' + $X + ',"y":' + $Y + ',"restored":true}')
    }
    'postclick' {
      if ($X -eq -999999 -or $Y -eq -999999) { Write-Output '{"ok":false,"error":"need x,y"}'; exit 0 }
      if ($Title -eq '') { Write-Output '{"ok":false,"error":"need title"}'; exit 0 }
      $h = [Win32Act]::FindByTitle($Title)
      if ($h -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"error":"window not found"}'; exit 0 }
      $ok = [Win32Act]::PostClick($h, $X, $Y)
      if (-not $ok) { Write-Output '{"ok":false,"error":"postclick failed"}'; exit 0 }
      Write-Output ('{"ok":true,"action":"postclick","x":' + $X + ',"y":' + $Y + ',"cursorMoved":false}')
    }
    'key' {
      $vk = ConvertTo-VK $Key
      if ($vk -eq 0) { Write-Output ('{"ok":false,"error":"unknown key: ' + $Key + '"}'); exit 0 }
      [Win32Act]::keybd_event([byte]$vk, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds (50 + $rnd.Next(0, 60))
      [Win32Act]::keybd_event([byte]$vk, 0, [Win32Act]::KEYUP, [IntPtr]::Zero)
      Write-Output ('{"ok":true,"action":"key","key":"' + $Key + '"}')
    }
    'wait' {
      Write-Output '{"ok":true,"action":"wait"}'
    }
    default {
      Write-Output ('{"ok":false,"error":"unknown action: ' + $Action + '"}')
    }
  }
} catch {
  Write-Output ('{"ok":false,"error":"' + $_.Exception.Message.Replace('"', "'") + '"}')
}
