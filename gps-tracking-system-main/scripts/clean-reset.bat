@echo off
REM ════════════════════════════════════════════════════════════════
REM  NTPC-MUNPL GPS Tracking System — Clean Reset Script
REM  Run this script as ADMINISTRATOR to reset node_modules, data, and logs.
REM ════════════════════════════════════════════════════════════════

echo.
echo  ============================================================
echo   WARNING: This will completely reset the system:
echo     - Stop and uninstall the PM2 Windows service
echo     - Delete node_modules/ (re-installed automatically)
echo     - Delete logs/ (PM2 and application logs)
echo     - Delete data/ (SQLite history database)
echo  ============================================================
echo.
set /p confirm="Are you sure you want to proceed? (Y/N): "
if /i "%confirm%" neq "Y" (
    echo  Reset aborted.
    pause
    exit /b 0
)

REM Check for admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  ERROR: Please run this script as Administrator.
    pause
    exit /b 1
)

echo.
echo  1. Stopping and uninstalling existing service...
where pm2 >nul 2>&1
if %errorLevel% equ 0 (
    pm2 stop ntpc-gps >nul 2>&1
    pm2 delete ntpc-gps >nul 2>&1
    pm2 save --force >nul 2>&1
)
where pm2-installer >nul 2>&1
if %errorLevel% equ 0 (
    pm2-installer uninstall >nul 2>&1
)

REM Move to the project root directory
cd /d "%~dp0.."

echo.
echo  2. Cleaning directories...
if exist "node_modules" (
    echo    Removing node_modules...
    rmdir /s /q "node_modules"
)
if exist "logs" (
    echo    Removing logs...
    rmdir /s /q "logs"
)
if exist "data" (
    echo    Removing SQLite data...
    rmdir /s /q "data"
)

echo.
echo  3. Recreating logs and data directories...
mkdir logs
mkdir data

echo.
echo  4. Reinstalling dependencies (clean install)...
call npm install --omit=dev

echo.
echo  5. Re-registering and starting service...
where pm2 >nul 2>&1
if %errorLevel% neq 0 (
    echo  Installing PM2 globally...
    call npm install -g pm2
)
where pm2-installer >nul 2>&1
if %errorLevel% neq 0 (
    echo  Installing pm2-installer...
    call npm install -g @jessety/pm2-installer
)

echo  Starting app with PM2...
call pm2 start ecosystem.config.js --env production
call pm2 save
call pm2-installer install

echo.
echo  ============================================================
echo   NTPC GPS Tracking System reset and redeployed successfully!
echo  ============================================================
echo.
pause
