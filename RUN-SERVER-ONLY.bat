@echo off
title Break Monitor - server only
cd /d "%~dp0"
echo Starting the Break Monitor server (no desktop window).
echo Staff can open the address shown below in any browser on the network.
echo Press Ctrl+C to stop.
echo.
node src\server\standalone.js --port 8080
pause
