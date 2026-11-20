@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AIBridge - NapCat 容器

echo.
echo   ============================================
echo      启动 NapCat（内置 QQ Linux 客户端）
echo   ============================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Docker
  echo   请先安装 Docker Desktop: https://www.docker.com/products/docker-desktop/
  echo.
  pause
  exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
  echo   [错误] Docker 没有运行，请先打开 Docker Desktop
  echo.
  pause
  exit /b 1
)

echo   正在启动容器（首次会拉取约 700MB 镜像）...
echo.
docker compose up -d
if errorlevel 1 (
  echo.
  echo   [错误] 启动失败，请检查上面的输出
  pause
  exit /b 1
)

echo.
echo   等待 NapCat 初始化（约 15 秒）...
timeout /t 15 >nul

echo.
echo   ============================================
echo      WebUI Token
echo   ============================================
powershell -NoProfile -Command "try { $t = (Get-Content 'napcat\config\webui.json' -Raw | ConvertFrom-Json).token; Write-Host ('  ' + $t) -ForegroundColor Green } catch { Write-Host '  尚未生成。稍等片刻后重新运行本脚本，或执行: docker compose logs napcat' -ForegroundColor Yellow }"

echo.
echo   下一步：
echo     1. 打开 http://localhost:8787  -^>  「账号接入」
echo     2. WebUI 地址填 http://127.0.0.1:6099
echo     3. Token 填上面的值，点「检测连接」
echo     4. 手机 QQ 扫码登录
echo.
echo   查看日志: docker compose logs -f napcat
echo   停止容器: docker compose down
echo.
pause
