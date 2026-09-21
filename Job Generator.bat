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

REM The server opens the browser itself, on whichever port it ends up with
REM (Windows can reserve 4173, in which case it moves to the next free port).
set JG_OPEN_BROWSER=1

echo.
echo Job Generator is starting -- your browser will open by itself.
echo Close this window (or press Ctrl+C) to stop it.
echo.
node server.js
