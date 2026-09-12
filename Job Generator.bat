@echo off
title FranVision Job Generator
REM FranVision Job Generator -- double-click this file to run (Windows).
REM Starts the local server and opens the UI in your default browser.
REM macOS users: use "Job Generator.command" instead.

cd /d "%~dp0job-generator"

where node >nul 2>nul || (
  echo.
  echo Node.js was not found on your PATH.
  echo Install the LTS build from https://nodejs.org/ then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run -- installing dependencies ^(npm install^)...
  call npm install || (echo npm install failed. & pause & exit /b 1)
)

REM Open the browser a couple of seconds after the server starts, from a
REM hidden detached PowerShell so this window stays dedicated to the server.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:4173'"

echo.
echo Job Generator is running at http://localhost:4173
echo Close this window (or press Ctrl+C) to stop it.
echo.
node server.js
