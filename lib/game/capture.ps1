param(
  [string]$Title = "",
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$MaxWidth = 1024,
  [string]$Format = "png"
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Game {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }

  public static IntPtr FindByTitle(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string t = sb.ToString();
      // fuzzy match: titles are often like "Minecraft 26.3"
      if (t.Length > 0 && t.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = h; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

if (-not ('Win32Game' -as [type])) {
  Add-Type -TypeDefinition $sig
}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

$srcX = 0
$srcY = 0
$srcW = $screen.Width
$srcH = $screen.Height
$mode = 'fullscreen'

if ($Title -ne '') {
  $h = [Win32Game]::FindByTitle($Title)
  if ($h -eq [IntPtr]::Zero) {
    Write-Output '{"ok":false,"error":"window not found"}'
    exit 0
  }
  [void][Win32Game]::ShowWindow($h, 9)
  [void][Win32Game]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 250

  $r = New-Object Win32Game+RECT
  [void][Win32Game]::GetClientRect($h, [ref]$r)
  $p = New-Object Win32Game+POINT
  [void][Win32Game]::ClientToScreen($h, [ref]$p)

  $srcX = $p.X
  $srcY = $p.Y
  $srcW = $r.Right - $r.Left
  $srcH = $r.Bottom - $r.Top
  $mode = 'window'
}

if ($srcW -le 0 -or $srcH -le 0) {
  Write-Output '{"ok":false,"error":"invalid capture region"}'
  exit 0
}

# 抓取原图，再等比缩放到目标尺寸
$dstW = $srcW
if ($MaxWidth -gt 0 -and $srcW -gt $MaxWidth) { $dstW = $MaxWidth }
$dstH = [int][Math]::Round($srcH * ($dstW / $srcW))

$raw = New-Object System.Drawing.Bitmap $srcW, $srcH
$g1 = [System.Drawing.Graphics]::FromImage($raw)
$g1.CopyFromScreen($srcX, $srcY, 0, 0, (New-Object System.Drawing.Size($srcW, $srcH)))
$g1.Dispose()

$bmp = New-Object System.Drawing.Bitmap $dstW, $dstH
$g2 = [System.Drawing.Graphics]::FromImage($bmp)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($raw, 0, 0, $dstW, $dstH)
$g2.Dispose()

if ($Format -eq 'jpeg') {
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
} else {
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
}
$bmp.Dispose()
$raw.Dispose()

$result = [ordered]@{
  ok      = $true
  mode    = $mode
  srcX    = $srcX
  srcY    = $srcY
  srcW    = $srcW
  srcH    = $srcH
  imgW    = $dstW
  imgH    = $dstH
  path    = $Out
}

$result | ConvertTo-Json -Compress
