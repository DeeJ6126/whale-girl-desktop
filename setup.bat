@echo off
chcp 65001 >nul
title whale-girl desktop pet
cd /d "%~dp0"

echo === whale-girl desktop pet ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js not found in PATH. Install Node.js 22+ first.
  pause
  exit /b 1
)

echo [1/3] checking DSH web on 127.0.0.1:3080 ...
curl -s -o nul -m 3 http://127.0.0.1:3080
if errorlevel 1 (
  echo   WARN: DSH web is not running. Start it first (the pet needs it).
  echo   Press any key to continue anyway, or close this window.
  pause
)

echo [2/3] checking whale-girl /sessions endpoint ...
curl -s -m 3 http://127.0.0.1:3080/whale-girl/sessions | findstr /c:"activity" >nul
if errorlevel 1 (
  echo   WARN: /whale-girl/sessions not available. Install the whale-girl plugin
  echo   with the sessions endpoint, then restart dsh:
  echo     dsh plugin --profile web add github:xiaoshihou514/whale-girl#codex/external-state-api
  echo   Press any key to continue anyway.
  pause
)

echo [3/3] checking Electron ...
if not exist node_modules\electron\dist\electron.exe (
  echo   Electron missing. Installing (mirror first, GitHub fallback)...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  npm install
  if errorlevel 1 (
    echo   npm install failed. Try: set ELECTRON_MIRROR=... ^& node node_modules\electron\install.js
    pause
    exit /b 1
  )
)

echo.
echo Starting the pet. Leave this window open.
echo Click pet = toggle DSH web window | Right-click = size | Drag = move
echo.
start "" "%~dp0node_modules\electron\dist\electron.exe" .
