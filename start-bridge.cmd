@echo off
cd /d "%~dp0"
title Claude Watch Bridge
echo.
echo   Claude Watch - Bridge Server
echo   The pairing code and address appear below.
echo   Keep this window open (close it to stop).
echo.
node skill\bridge\server.js
echo.
echo   Bridge stopped. Press any key to close.
pause >nul
