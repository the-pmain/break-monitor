@echo off
title Break Monitor
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run - installing dependencies, this takes a few minutes...
  call npm install
)
call npm start
