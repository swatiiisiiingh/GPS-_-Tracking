@echo off
REM ════════════════════════════════════════════════════════════════
REM  NTPC-MUNPL GPS Tracking System — Uninstall Windows Service via NSSM
REM  Run this script as ADMINISTRATOR.
REM ════════════════════════════════════════════════════════════════

echo.
echo  Uninstalling NTPC GPS Tracking System Windows Service (NSSM)...
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
    if exist "C:\nssm\nssm.exe" (
        set "NSSM_CMD=C:\nssm\nssm.exe"
    ) else if exist "%~dp0\nssm.exe" (
        set "NSSM_CMD=%~dp0\nssm.exe"
    ) else if exist "%~dp0..\nssm.exe" (
        set "NSSM_CMD=%~dp0..\nssm.exe"
    ) else (
        echo  ERROR: NSSM executable (nssm.exe) not found!
        echo  Please place nssm.exe in the same path as during installation to uninstall.
        pause
        exit /b 1
    )
)

REM 3. Stop and remove the service
echo  Stopping service "ntpc-gps"...
"%NSSM_CMD%" stop "ntpc-gps" >nul 2>&1

echo  Removing service "ntpc-gps"...
"%NSSM_CMD%" remove "ntpc-gps" confirm
if %errorLevel% equ 0 (
    echo.
    echo  ============================================================
    echo   NTPC GPS Windows Service uninstalled successfully!
    echo  ============================================================
) else (
    echo.
    echo  ERROR: Failed to remove the service. It might not exist.
)
echo.
pause
