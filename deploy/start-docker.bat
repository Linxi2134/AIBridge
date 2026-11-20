@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AIBridge · Docker 部署

echo.
echo   ============================================
echo      AIBridge · NapCat 容器部署
echo   ============================================
echo.

set DOCKER_BIN=C:\Program Files\Docker\Docker\resources\bin
set PATH=%PATH%;%DOCKER_BIN%

REM ---- 1. 检查 Docker 是否就绪 ----
docker version >nul 2>nul
if not errorlevel 1 goto :ready

echo   [1/3] Docker 未运行，正在启动 Docker Desktop...
echo.

if not exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
  echo   [错误] 找不到 Docker Desktop
  echo   请先安装: https://www.docker.com/products/docker-desktop/
  pause
  exit /b 1
)

start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"

echo   等待 Docker 就绪（最多 3 分钟）...
echo   ^(首次启动可能要求接受服务条款，请在弹出的窗口里点 Accept^)
echo.

set READY=0
for /l %%i in (1,1,60) do (
  timeout /t 3 >nul
  docker version >nul 2>nul
  if not errorlevel 1 (
    set READY=1
    goto :ready
  )
  <nul set /p "."
)

:ready
echo.
echo   [2/3] Docker 已就绪，正在启动容器...
echo.

docker compose up -d
if errorlevel 1 (
  echo.
  echo   [错误] 容器启动失败，请检查上面的输出
  pause
  exit /b 1
)

echo.
echo   [3/3] 等待 NapCat 初始化...
timeout /t 20 >nul

echo.
echo   ============================================
echo      部署完成
echo   ============================================
echo.
echo   查看日志: docker compose logs -f napcat
echo   停止:     docker compose down
echo.
echo   接下来：
echo     1. 打开 http://localhost:8787  -^>  「账号接入」
echo     2. WebUI 地址填  http://127.0.0.1:6099
echo     3. Token 在 deploy\napcat\config\webui.json 里
echo     4. 点「检测连接」-^>  手机 QQ 扫码
echo.
pause
