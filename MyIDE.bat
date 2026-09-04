@echo off
title My IDE 编辑器
cd /d "%~dp0"

echo.
echo  ============================================
echo    My IDE - 私人定制轻量编辑器
echo  ============================================
echo.

rem ---- 检测 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未检测到 Node.js，请先到 https://nodejs.org 安装后重试。
  pause
exit /b 1
)

rem ---- Electron 二进制镜像（国内加速，防下载失败）----
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

rem ---- 首次运行：检测 electron.exe 是否存在（而非仅目录）----
if not exist "node_modules\electron\dist\electron.exe" (
  echo  [首次运行] 正在安装依赖，约 1-2 分钟，请耐心等待...
  echo.
  call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
  if errorlevel 1 (
    echo.
    echo  [错误] 依赖安装失败，请检查网络后重新运行本脚本。
    pause
    exit /b 1
  )
  if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo  [错误] Electron 二进制下载失败，正在重试安装 electron...
    call npm install electron --force --no-audit --no-fund --registry=https://registry.npmmirror.com
    if errorlevel 1 (
      echo  [错误] Electron 仍安装失败，请检查网络（需要访问 npmmirror.com）。
      pause
      exit /b 1
    )
  )
  echo.
  echo  [安装完成]
  echo.
)

rem ---- 启动应用（禁用 GPU 沙箱，日志写入 app.log）----
set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_DISABLE_SECURITY_WARNINGS=1
echo  [提示] 正在启动 My IDE ...
echo  本窗口请保持打开，关闭应用后会自动退出。
echo.
"node_modules\electron\dist\electron.exe" . --disable-gpu --no-sandbox >app.log 2>&1
if errorlevel 1 (
  echo.
  echo  [错误] My IDE 启动失败！
  echo  日志已保存到项目目录下 app.log，请打开排查。
  pause
)
