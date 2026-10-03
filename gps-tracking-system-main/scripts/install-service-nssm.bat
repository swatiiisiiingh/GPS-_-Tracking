@echo off
REM ════════════════════════════════════════════════════════════════
REM  NTPC-MUNPL GPS Tracking System — Install as Windows Service via NSSM
REM  Run this script as ADMINISTRATOR on the Windows Server 2012 R2.
REM ════════════════════════════════════════════════════════════════

echo.
echo  Installing NTPC GPS Tracking System as a Windows Service using NSSM...
echo.

REM 1. Check for admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  ERROR: Please run this script as Administrator.
    pause
    exit /b 1
)

REM 2. Detect NSSM command
set "NSSM_CMD=nssm"
where nssm >nul 2>&1
if %errorLevel% neq 0 (
    echo  WARNING: 'nssm' was not found in your system PATH.
    echo  Checking common locations...
    if exist "C:\nssm\nssm.exe" (
        set "NSSM_CMD=C:\nssm\nssm.exe"
        echo  Found NSSM at: C:\nssm\nssm.exe
    ) else if exist "%~dp0\nssm.exe" (
        set "NSSM_CMD=%~dp0\nssm.exe"
        echo  Found NSSM in script folder.
    ) else if exist "%~dp0..\nssm.exe" (
        set "NSSM_CMD=%~dp0..\nssm.exe"
        echo  Found NSSM in root folder.
    ) else (
        echo.
        echo  ERROR: NSSM executable (nssm.exe) not found!
        echo  Please download NSSM from https://nssm.cc/download and place it in system PATH,
        echo  or copy it to the root of this project folder.
        pause
        exit /b 1
    )
)

REM 3. Detect Node.exe path
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo  ERROR: Node.js was not found. Please install Node.js 18.x on the server first.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('where node') do set "NODE_PATH=%%i"
echo  Node.js executable found at: %NODE_PATH%

REM 4. Resolve absolute paths
cd /d "%~dp0.."
set "APP_DIR=%cd%"
set "SERVER_JS=%APP_DIR%\server.js"
set "LOGS_DIR=%APP_DIR%\logs"

echo  Application Directory: %APP_DIR%

REM 5. Prepare folders
if not exist "%LOGS_DIR%" mkdir "%LOGS_DIR%"

REM 6. Install service using NSSM
echo  Installing service "ntpc-gps"...
"%NSSM_CMD%" install "ntpc-gps" "%NODE_PATH%" """%SERVER_JS%"""
if %errorLevel% neq 0 (
    echo  ERROR: NSSM failed to install the service. It might already exist.
    echo  Try uninstalling it first using uninstall-service-nssm.bat.
    pause
    exit /b 1
)

REM 7. Configure NSSM settings
echo  Configuring service options...
"%NSSM_CMD%" set "ntpc-gps" AppDirectory "%APP_DIR%"
"%NSSM_CMD%" set "ntpc-gps" Description "NTPC-MUNPL GPS Tracking System Server"
"%NSSM_CMD%" set "ntpc-gps" Start SERVICE_AUTO_START
"%NSSM_CMD%" set "ntpc-gps" AppStdout "%LOGS_DIR%\nssm-stdout.log"
"%NSSM_CMD%" set "ntpc-gps" AppStderr "%LOGS_DIR%\nssm-stderr.log"
"%NSSM_CMD%" set "ntpc-gps" AppEnvironmentExtra NODE_ENV=production

REM 8. Start Service
echo  Starting service...
"%NSSM_CMD%" start "ntpc-gps"

echo.
echo  ============================================================
echo   NTPC GPS Service registered and started successfully!
echo   It will now auto-start on server boot.
echo.
echo   NSSM Logs redirected to:
echo     Stdout: %LOGS_DIR%\nssm-stdout.log
echo     Stderr: %LOGS_DIR%\nssm-stderr.log
echo.
echo   Useful NSSM Commands:
echo     nssm status ntpc-gps  - Check running state
echo     nssm stop ntpc-gps    - Stop the service
echo     nssm start ntpc-gps   - Start the service
echo  ============================================================
echo.
pause
