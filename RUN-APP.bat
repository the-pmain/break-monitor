@echo off
title Break Monitor
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org then run this again.
  pause
  exit /b 1
)
echo Starting Break Monitor at http://localhost:8080
echo Open that address in a browser. Press Ctrl+C to stop.
echo.
node src\server\standalone.js --port 8080
pause
