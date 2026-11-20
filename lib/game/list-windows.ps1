param()

$ErrorActionPreference = 'Stop'

# PowerShell 默认按系统代码页输出，Node 按 UTF-8 读会乱码，这里强制改成 UTF-8
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$sig = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Win32List {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static List<string> ListTitles() {
    List<string> list = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string t = sb.ToString().Trim();
      if (t.Length > 0) {
        RECT r;
        if (GetClientRect(h, out r)) {
          int w = r.Right - r.Left;
          int hh = r.Bottom - r.Top;
          if (w > 200 && hh > 200) list.Add(t);
        }
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

if (-not ('Win32List' -as [type])) {
  Add-Type -TypeDefinition $sig
}

$titles = [Win32List]::ListTitles()
$result = [ordered]@{ ok = $true; windows = @($titles | Select-Object -Unique) }
$result | ConvertTo-Json -Compress
