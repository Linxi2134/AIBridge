param(
  [Parameter(Mandatory=$true)][string]$Action,
  [int]$DX = 0,
  [int]$DY = 0,
  [string]$Text = "",
  [string]$Key = "",
  [int]$Ms = 300,
  [string]$Title = "Minecraft"
)

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class McCtl {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr extra);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  public const uint MOVE = 0x0001;
  public const uint KEYUP = 0x0002;

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

  // SetForegroundWindow 对后台进程会静默失败，必须先把本线程挂到前台窗口的输入队列上
  public static bool ForceForeground(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    if (GetForegroundWindow() == h) return true;

    uint fgPid;
    IntPtr fg = GetForegroundWindow();
    uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
    uint myThread = GetCurrentThreadId();

    bool attached = false;
    if (fgThread != 0 && fgThread != myThread) {
      attached = AttachThreadInput(myThread, fgThread, true);
    }

    ShowWindow(h, 9);
    BringWindowToTop(h);
    SetForegroundWindow(h);

    if (attached) AttachThreadInput(myThread, fgThread, false);

    return GetForegroundWindow() == h;
  }
}
'@

if (-not ('McCtl' -as [type])) {
  Add-Type -TypeDefinition $sig
}

function Focus-Target {
  if ($Title -eq '') { return }
  $h = [McCtl]::FindFuzzy($Title)
  if ($h -eq [IntPtr]::Zero) {
    Write-Output '{"ok":false,"error":"window not found"}'
    exit 0
  }
  $ok = [McCtl]::ForceForeground($h)
  if (-not $ok) {
    Write-Output '{"ok":false,"error":"failed to focus game window"}'
    exit 0
  }
  Start-Sleep -Milliseconds 150
}

$rnd = New-Object System.Random

function Send-KeyDown([byte]$vk) { [McCtl]::keybd_event($vk, 0, 0, [IntPtr]::Zero) }
function Send-KeyUp([byte]$vk) { [McCtl]::keybd_event($vk, 0, [McCtl]::KEYUP, [IntPtr]::Zero) }

function Press([byte]$vk, [int]$ms = 45) {
  Send-KeyDown $vk
  Start-Sleep -Milliseconds ($ms + $rnd.Next(0, 25))
  Send-KeyUp $vk
  Start-Sleep -Milliseconds 12
}

# 单个字符 → 按键（MC 命令只用到 ASCII，够用）
function Send-Char([char]$ch) {
  $code = [int][char]$ch
  $vk = 0
  $shift = $false

  if ($code -ge 97 -and $code -le 122) { $vk = $code - 32 }
  elseif ($code -ge 65 -and $code -le 90) { $vk = $code; $shift = $true }
  elseif ($code -ge 48 -and $code -le 57) { $vk = $code }
  elseif ($ch -eq ' ') { $vk = 0x20 }
  elseif ($ch -eq '/') { $vk = 0xBF }
  elseif ($ch -eq '.') { $vk = 0xBE }
  elseif ($ch -eq ',') { $vk = 0xBC }
  elseif ($ch -eq '-') { $vk = 0xBD }
  elseif ($ch -eq '=') { $vk = 0xBB }
  elseif ($ch -eq ';') { $vk = 0xBA }
  elseif ($ch -eq '[') { $vk = 0xDB }
  elseif ($ch -eq ']') { $vk = 0xDD }
  elseif ($ch -eq '\\') { $vk = 0xDC }
  elseif ($ch -eq "'") { $vk = 0xDE }
  elseif ($ch -eq '`') { $vk = 0xC0 }
  elseif ($ch -eq '@') { $vk = 0x32; $shift = $true }
  elseif ($ch -eq ':') { $vk = 0xBA; $shift = $true }
  elseif ($ch -eq '~') { $vk = 0xC0; $shift = $true }
  elseif ($ch -eq '_') { $vk = 0xBD; $shift = $true }
  elseif ($ch -eq '+') { $vk = 0xBB; $shift = $true }
  elseif ($ch -eq '!') { $vk = 0x31; $shift = $true }
  elseif ($ch -eq '?') { $vk = 0xBF; $shift = $true }
  elseif ($ch -eq '*') { $vk = 0x38; $shift = $true }
  elseif ($ch -eq '(') { $vk = 0x39; $shift = $true }
  elseif ($ch -eq ')') { $vk = 0x30; $shift = $true }
  elseif ($ch -eq '#') { $vk = 0x33; $shift = $true }
  elseif ($ch -eq '^') { $vk = 0x36; $shift = $true }
  elseif ($ch -eq '&') { $vk = 0x37; $shift = $true }
  elseif ($ch -eq '%') { $vk = 0x35; $shift = $true }
  elseif ($ch -eq '$') { $vk = 0x34; $shift = $true }
  else { return $false }

  if ($shift) { Send-KeyDown 0x10 }
  Press ([byte]$vk) 30
  if ($shift) { Send-KeyUp 0x10 }
  return $true
}

try {
  switch ($Action.ToLower()) {
    'look' {
      Focus-Target
      # MC 的视角靠相对移动，分几步走更像人手
      $steps = 4
      for ($i = 0; $i -lt $steps; $i++) {
        $sx = [int][Math]::Round($DX / $steps)
        $sy = [int][Math]::Round($DY / $steps)
        [McCtl]::mouse_event([McCtl]::MOVE, $sx, $sy, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds (14 + $rnd.Next(0, 12))
      }
      Write-Output ('{"ok":true,"action":"look","dx":' + $DX + ',"dy":' + $DY + '}')
    }
    'chat' {
      Focus-Target
      if ($Text -eq '') { Write-Output '{"ok":false,"error":"text is empty"}'; exit 0 }
      Press 0x54 40          # T 打开聊天栏
      Start-Sleep -Milliseconds 240
      # 打开聊天栏的那次 T 会顺带把字符 't' 输入进去，先退格清掉
      for ($i = 0; $i -lt 4; $i++) { Press 0x08 25 }
      Start-Sleep -Milliseconds 100
      $sent = 0
      foreach ($ch in $Text.ToCharArray()) {
        if (Send-Char $ch) { $sent += 1 }
      }
      Start-Sleep -Milliseconds 140
      Press 0x0D 40          # Enter
      Write-Output ('{"ok":true,"action":"chat","chars":' + $sent + ',"text":"' + $Text.Replace('"', "'") + '"}')
    }
    'key' {
      Focus-Target
      if ($Key -eq '') { Write-Output '{"ok":false,"error":"key is empty"}'; exit 0 }
      $map = @{ 'W'=0x57; 'A'=0x41; 'S'=0x53; 'D'=0x44; 'SPACE'=0x20; 'SHIFT'=0x10; 'CTRL'=0x11
                'E'=0x45; 'Q'=0x51; 'ESC'=0x1B; 'TAB'=0x09; 'F'=0x46; 'F3'=0x72; 'F5'=0x74
                '1'=0x31; '2'=0x32; '3'=0x33; '4'=0x34; '5'=0x35; '6'=0x36; '7'=0x37; '8'=0x38; '9'=0x39 }
      $k = $Key.ToUpper()
      if (-not $map.ContainsKey($k)) { Write-Output ('{"ok":false,"error":"unknown key"}'); exit 0 }
      Press ([byte]$map[$k]) 60
      Write-Output ('{"ok":true,"action":"key","key":"' + $k + '"}')
    }
    'hold' {
      Focus-Target
      if ($Key -eq '') { Write-Output '{"ok":false,"error":"key is empty"}'; exit 0 }
      $map = @{ 'W'=0x57; 'A'=0x41; 'S'=0x53; 'D'=0x44; 'SPACE'=0x20; 'SHIFT'=0x10 }
      $k = $Key.ToUpper()
      if (-not $map.ContainsKey($k)) { Write-Output ('{"ok":false,"error":"unknown key"}'); exit 0 }
      Send-KeyDown ([byte]$map[$k])
      Start-Sleep -Milliseconds $Ms
      Send-KeyUp ([byte]$map[$k])
      Write-Output ('{"ok":true,"action":"hold","key":"' + $k + '","ms":' + $Ms + '}')
    }
    default {
      Write-Output ('{"ok":false,"error":"unknown action"}')
    }
  }
} catch {
  Write-Output ('{"ok":false,"error":"' + $_.Exception.Message.Replace('"', "'") + '"}')
}
