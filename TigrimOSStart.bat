@echo off
:: TigrimOS - Start Application (Windows / WSL2)
title TigrimOS - Starting...

echo.
echo   ========================================
echo      TigrimOS - Starting
echo   ========================================
echo.

:: Check WSL is available
wsl --status >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [ERROR] WSL2 is not installed or not enabled.
    echo   Please run TigrimOSInstaller.bat first.
    echo.
    pause
    exit /b 1
)

:: Check if TigrimOS distro exists
wsl -d TigrimOS -- echo ok >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [ERROR] TigrimOS WSL distribution not found.
    echo   Please run TigrimOSInstaller.bat first.
    echo.
    pause
    exit /b 1
)

:: Kill any existing TigrimOS server
echo   Stopping any existing TigrimOS server...
wsl -d TigrimOS -u root -- bash -c "pkill -f 'node.*server' 2>/dev/null; pkill -f 'tsx.*index' 2>/dev/null; true"
timeout /t 1 /nobreak >nul

:: Start TigrimOS server inside WSL2 in a minimized window
:: The WSL session must stay alive for the server to keep running
echo   Starting TigrimOS server...
echo.
start "TigrimOS Server" /min "%~dp0TigrimOSServer.bat"

echo   Waiting for server to start...
set TRIES=0

:wait_server
timeout /t 2 /nobreak >nul
set /a TRIES+=1

:: Check if server is responding
curl -s -o nul -w "" --connect-timeout 2 --max-time 3 http://localhost:3001 >nul 2>&1
if %ERRORLEVEL% equ 0 goto :server_ready

if %TRIES% geq 30 (
    echo.
    echo   [WARNING] Server did not respond in time.
    echo   Check logs: wsl -d TigrimOS -u root -- cat /tmp/tigrimos.log
    echo   Opening anyway...
    goto :open_browser
)
echo   Still waiting... (%TRIES%)
goto :wait_server

:server_ready
echo.
echo   TigrimOS is running!

:open_browser
echo   Opening TigrimOS...
echo.
:: Launch as standalone app window using Edge app mode via PowerShell (avoids batch quoting issues)
powershell -Command "if (Test-Path 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe') { Start-Process 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList '--app=http://localhost:3001','--window-size=1280,800' } elseif (Test-Path 'C:\Program Files\Microsoft\Edge\Application\msedge.exe') { Start-Process 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' -ArgumentList '--app=http://localhost:3001','--window-size=1280,800' } else { Start-Process 'http://localhost:3001' }"

echo.
echo   TigrimOS is running. The server runs in the minimized window.
echo   To stop: close the "TigrimOS Server" window, or run TigrimOSStop.bat
echo.
pause
