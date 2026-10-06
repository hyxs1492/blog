@echo off
rem blogctl - one-click start/stop for the local blog preview (Windows launcher).
rem This file is intentionally pure ASCII: cmd.exe parses .cmd in the console code page,
rem so non-ASCII comments can break parsing. All user-facing text comes from blogctl.mjs.
rem usage: blogctl start | blogctl stop | blogctl status | blogctl logs -f ...
setlocal
chcp 65001 >nul 2>nul

where node >nul 2>nul
if errorlevel 1 (
  echo [x] node not found. Install Node.js 22+ first: https://nodejs.org/
  exit /b 1
)

node "%~dp0blogctl.mjs" %*
exit /b %ERRORLEVEL%
