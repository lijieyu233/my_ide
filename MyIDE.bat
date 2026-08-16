@echo off
title My IDE 启动器
cd /d "%~dp0"

echo.
echo  ============================================
echo    My IDE - 私人定制轻量编辑器
echo  ============================================
echo.

rem ---- 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未检测到 Node.js，请先到 https://nodejs.org 安装后重试。
  pause
  exit /b 1
)

rem ---- 首次运行自动安装依赖 ----
if not exist node_modules\electron (
  echo  [首次运行] 正在安装依赖（约 1-2 分钟），请稍候...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [错误] 依赖安装失败，请检查网络后重新运行本脚本。
    pause
    exit /b 1
  )
  echo.
  echo  [安装完成]
  echo.
)

rem ---- 启动（禁用 GPU 加速 + 关闭沙箱，解决部分机器闪退；日志写入 app.log）----
set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_DISABLE_SECURITY_WARNINGS=1
echo  [启动] 正在打开 My IDE 窗口...
echo  （本窗口请保留，关闭应用后它会自动退出）
echo.
node_modules\electron\dist\electron.exe . --disable-gpu --no-sandbox >app.log 2>&1
if errorlevel 1 (
  echo.
  echo  [错误] My IDE 启动失败！
  echo  日志已保存到本目录的 app.log，请把它发给我排查。
  pause
)