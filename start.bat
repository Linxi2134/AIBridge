@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AIBridge · 多平台 AI 接入网关

echo.
echo   ============================================
echo      AIBridge · 多平台 AI 接入网关
echo   ============================================
echo.

REM ---- 优先使用内置 Node，找不到再回退到系统 Node ----
set "NODE_EXE=%~dp0runtime\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE="

if not defined NODE_EXE (
  where node >nul 2>nul
  if errorlevel 1 (
    echo   [错误] 找不到 Node 运行时
    echo.
    echo   正常情况下产品目录里应包含:
    echo     runtime\node\node.exe
    echo.
    echo   如果这个文件不见了，请重新解压完整的产品包，
    echo   或者安装 Node.js 18+ : https://nodejs.org
    echo.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
  echo   使用系统 Node.js
) else (
  echo   使用内置 Node 运行时
)

for /f "tokens=*" %%v in ('"%NODE_EXE%" -v 2^>nul') do set NODEVER=%%v
echo   版本 %NODEVER%
echo.
echo   服务运行中，窗口会在就绪后自动弹出。
echo   关闭这个黑窗口即停止服务（QQ 机器人会离线）。
echo.

REM ---- 等服务就绪后再开窗口，避免启动器重复拉起服务 ----
set /a WAIT=0
:wait
curl -s -m 1 -o nul http://127.0.0.1:8787/api/status 2>nul
if not errorlevel 1 goto openwin
set /a WAIT+=1
if %WAIT% geq 40 goto openwin
ping -n 2 127.0.0.1 >nul
goto wait

:openwin
start "" wscript.exe "%~dp0AIBridge.vbs"

"%NODE_EXE%" server.js

echo.
echo   服务已停止。
pause
