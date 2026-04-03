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
wsl -d TigrimOS -- bash -c "pkill -f 'node.*server' 2>/dev/null; pkill -f 'tsx.*index' 2>/dev/null; true"
timeout /t 1 /nobreak >nul

:: Start TigrimOS server inside WSL2
echo   Starting TigrimOS server...
echo.

start /b "" wsl -d TigrimOS -u root -- bash -c "cd /opt/TigrimOS/tiger_cowork && NODE_ENV=production PORT=3001 node_modules/.bin/tsx server/index.ts >> /tmp/tigrimos.log 2>&1"

echo   Waiting for server to start...
set TRIES=0

:wait_server
timeout /t 2 /nobreak >nul
set /a TRIES+=1

:: Check if server is responding
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:3001' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if %ERRORLEVEL% equ 0 goto :server_ready

if %TRIES% geq 30 (
    echo.
    echo   [WARNING] Server did not respond in time.
    echo   Check logs: wsl -d TigrimOS -- cat /tmp/tigrimos.log
    echo   Opening browser anyway...
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
:: Launch as standalone app window using Edge app mode
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3001 --window-size=1280,800
) else if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3001 --window-size=1280,800
) else (
    start "" "http://localhost:3001"
)

echo   TigrimOS is running in background.
echo   To stop: wsl -d TigrimOS -- pkill -f "node.*server"
echo.
echo   Press any key to close this window (server keeps running)...
pause >nul
