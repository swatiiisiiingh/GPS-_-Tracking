@echo off
REM ════════════════════════════════════════════════════════════════
REM  NTPC-MUNPL GPS Tracking System — Install as Windows Service
REM  Run this script as ADMINISTRATOR on the NTPC server.
REM ════════════════════════════════════════════════════════════════

echo.
echo  Installing NTPC GPS Tracking System as a Windows Service...
echo.

REM Check for admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  ERROR: Please run this script as Administrator.
    pause
    exit /b 1
)

REM Install PM2 globally if not present
where pm2 >nul 2>&1
if %errorLevel% neq 0 (
    echo  Installing PM2 globally...
    npm install -g pm2
)

REM Install pm2-installer to run PM2 as a Windows Service
where pm2-installer >nul 2>&1
if %errorLevel% neq 0 (
    echo  Installing pm2-installer...
    npm install -g @jessety/pm2-installer
)

REM Move to the project directory (edit this path if different)
cd /d "%~dp0.."

REM Install production dependencies only
echo  Installing production dependencies...
npm install --omit=dev

REM Create logs directory
if not exist "logs" mkdir logs

REM Start the app with PM2 using production env
echo  Starting app with PM2...
pm2 start ecosystem.config.js --env production

REM Save the PM2 process list so it survives reboots
pm2 save

REM Configure PM2 to start on Windows startup
pm2-installer install

echo.
echo  ============================================================
echo   NTPC GPS Tracking System installed successfully!
echo   The server will now start automatically on system boot.
echo.
echo   Useful commands:
echo     pm2 status          - Check running status
echo     pm2 logs ntpc-gps   - View live logs
echo     pm2 restart ntpc-gps - Restart the server
echo     pm2 stop ntpc-gps   - Stop the server
echo  ============================================================
echo.
pause
