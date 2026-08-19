@echo off
title Break Monitor - build Windows installer
cd /d "%~dp0"
echo.
echo  Break Monitor - building the Windows installer
echo  ==============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed.
  echo  Download it from https://nodejs.org  ^(the LTS version^), then run this again.
  echo.
  pause
  exit /b 1
)
echo  Installing build tools... this takes a few minutes the first time.
call npm install
if errorlevel 1 goto failed
echo.
echo  Building the installer...
call npm run dist
if errorlevel 1 goto failed
echo.
echo  Done. Your installer is in the "dist" folder:
dir /b dist\*.exe
echo.
echo  Copy that .exe to each PC and run it.
pause
exit /b 0
:failed
echo.
echo  Build failed - see the messages above.
pause
exit /b 1
