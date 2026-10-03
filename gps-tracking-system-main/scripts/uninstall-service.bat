@echo off
REM ════════════════════════════════════════════════════════════════
REM  NTPC-MUNPL GPS Tracking System — Uninstall Windows Service
REM  Run this script as ADMINISTRATOR.
REM ════════════════════════════════════════════════════════════════

echo.
echo  Uninstalling NTPC GPS Tracking System Windows Service...
echo.

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  ERROR: Please run this script as Administrator.
    pause
    exit /b 1
)

pm2 stop ntpc-gps
pm2 delete ntpc-gps
pm2 save --force
pm2-installer uninstall

echo.
echo  Service uninstalled successfully.
echo.
pause
