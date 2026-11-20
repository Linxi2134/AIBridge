@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 停止 AIBridge

echo.
echo   正在停止 AIBridge 服务...
echo.

powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*' }; if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; '已停止 ' + @($p).Count + ' 个服务进程' } else { '没有正在运行的服务' }"

echo.
echo   完成。
ping -n 3 127.0.0.1 >nul
