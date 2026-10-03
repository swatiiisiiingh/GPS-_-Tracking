@echo off
title NTPC GPS - Public Tunnel Starter
echo =======================================================
echo     NTPC-MUNPL GPS TRACKING SYSTEM - PUBLIC TUNNEL
echo =======================================================
echo.
echo  This script starts a free public tunnel using localtunnel.
echo  No account registration or signup is required.
echo.
echo  Make sure your main server (server.js) is running on port 3000
echo  BEFORE starting this tunnel.
echo.
echo  Starting tunnel...
echo.
call npx -y localtunnel --port 3000
echo.
echo  Tunnel closed or failed to start.
pause
