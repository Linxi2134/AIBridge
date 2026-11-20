param(
  [int]$Size = 72,
  [int]$R = 0,
  [int]$G = 120,
  [int]$B = 255
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$sig = @'
using System;
using System.Runtime.InteropServices;
public class AiCursorNative {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  public struct POINT { public int X; public int Y; }
}
'@

if (-not ('AiCursorNative' -as [type])) {
  Add-Type -TypeDefinition $sig
}

$hex = ('#{0:X2}{1:X2}{2:X2}' -f $R, $G, $B)
$half = [int]($Size / 2)
$pad = 8
$d = $Size - $pad * 2
$d2 = $d - 14

$xaml = @"
<Canvas xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="$Size" Height="$Size" Background="Transparent">
  <Ellipse x:Name="ring" Width="$d" Height="$d"
           Canvas.Left="$pad" Canvas.Top="$pad"
           Stroke="$hex" StrokeThickness="2.5"/>
  <Ellipse x:Name="inner" Width="$d2" Height="$d2"
           Canvas.Left="$(($pad + 7))" Canvas.Top="$(($pad + 7))"
           Stroke="$hex" StrokeThickness="1" Opacity="0.45"/>
  <Rectangle x:Name="dot" Width="3" Height="3"
             Canvas.Left="$($half - 1.5)" Canvas.Top="$($half - 1.5)"
             Fill="$hex"/>
  <Line x:Name="cx1" X1="$($half - 9)" Y1="$half" X2="$($half - 3)" Y2="$half" Stroke="$hex" StrokeThickness="1.5"/>
  <Line x:Name="cx2" X1="$($half + 3)" Y1="$half" X2="$($half + 9)" Y2="$half" Stroke="$hex" StrokeThickness="1.5"/>
  <Line x:Name="cy1" X1="$half" Y1="$($half - 9)" X2="$half" Y2="$($half - 3)" Stroke="$hex" StrokeThickness="1.5"/>
  <Line x:Name="cy2" X1="$half" Y1="$($half + 3)" X2="$half" Y2="$($half + 9)" Stroke="$hex" StrokeThickness="1.5"/>
</Canvas>
"@

$canvas = [System.Windows.Markup.XamlReader]::Parse($xaml)

$window = New-Object System.Windows.Window
$window.WindowStyle = [System.Windows.WindowStyle]::None
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ResizeMode = [System.Windows.ResizeMode]::NoResize
$window.Width = $Size
$window.Height = $Size
$window.IsHitTestVisible = $false
$window.Focusable = $false
$window.Content = $canvas

$script:pressed = $false
$script:accent = $hex
$script:warn = '#FF5A5A'

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(30)
$timer.Add_Tick({
  $p = New-Object AiCursorNative+POINT
  [void][AiCursorNative]::GetCursorPos([ref]$p)
  $window.Left = $p.X - $half
  $window.Top = $p.Y - $half

  $down = ([AiCursorNative]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0
  if ($down -ne $script:pressed) {
    $script:pressed = $down
    $c = if ($down) { $script:warn } else { $script:accent }
    $brush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($c))
    $canvas.FindName('ring').Stroke = $brush
    $canvas.FindName('dot').Fill = $brush
    $canvas.FindName('cx1').Stroke = $brush
    $canvas.FindName('cx2').Stroke = $brush
    $canvas.FindName('cy1').Stroke = $brush
    $canvas.FindName('cy2').Stroke = $brush
  }
})
$timer.Start()

$window.Add_Loaded({
  $p = New-Object AiCursorNative+POINT
  [void][AiCursorNative]::GetCursorPos([ref]$p)
  $window.Left = $p.X - $half
  $window.Top = $p.Y - $half

  # 写自己的 PID：node 那边 spawn 拿到的 pid 不一定是窗口进程，靠这个文件判断存活
  try {
    $pidFile = Join-Path $PSScriptRoot '..\..\data\cursor.pid'
    $PID | Out-File -FilePath $pidFile -Encoding ascii -Force
  } catch { }
})

$window.Add_Closed({
  try {
    $pidFile = Join-Path $PSScriptRoot '..\..\data\cursor.pid'
    Remove-Item $pidFile -ErrorAction SilentlyContinue
  } catch { }
})

[void]$window.ShowDialog()
