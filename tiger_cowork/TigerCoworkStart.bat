@echo off
:: Tiger Cowork - Start Application
title Tiger Cowork - Starting...

echo.
echo   ========================================
echo      Tiger Cowork - Starting
echo   ========================================
echo.

:: Try to find docker in common locations
where docker >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "DOCKER_CMD=docker"
    goto :found_docker
)

if exist "C:\Program Files\Docker\Docker\resources\bin\docker.exe" (
    set "DOCKER_CMD=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
    goto :found_docker
)

echo   [ERROR] Docker not found. Please make sure Docker Desktop is installed.
echo.
pause
exit /b 1

:found_docker

:: Check if Docker daemon is running
"%DOCKER_CMD%" info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   Docker is not running. Starting Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo   Waiting for Docker to start...

    set TRIES=0
    :wait_docker
    timeout /t 3 /nobreak >nul
    set /a TRIES+=1
    "%DOCKER_CMD%" info >nul 2>&1
    if %ERRORLEVEL% equ 0 goto :docker_ready
    if %TRIES% geq 40 (
        echo.
        echo   [ERROR] Docker did not start in time. Please open Docker Desktop manually and try again.
        pause
        exit /b 1
    )
    echo   Still waiting... (%TRIES%)
    goto :wait_docker
)

:docker_ready
echo   Docker is running.
echo.

:: Find the TigerCowork install directory
if exist "%~dp0docker-compose.yml" (
    set "INSTALL_DIR=%~dp0"
    goto :start_app
)

if exist "C:\TigerCowork\docker-compose.yml" (
    set "INSTALL_DIR=C:\TigerCowork"
    goto :start_app
)

echo   [ERROR] Cannot find Tiger Cowork installation.
echo   Please run this script from the Tiger Cowork install directory.
echo.
pause
exit /b 1

:start_app
echo   Starting Tiger Cowork...
echo.

pushd "%INSTALL_DIR%"
"%DOCKER_CMD%" compose up -d
popd

if %ERRORLEVEL% equ 0 (
    echo.
    echo   Tiger Cowork is starting up...
    echo   Opening browser at http://localhost:3001
    timeout /t 3 /nobreak >nul
    start "" "http://localhost:3001"
) else (
    echo.
    echo   [ERROR] Failed to start Tiger Cowork.
    echo   Check Docker Desktop for more details.
)

echo.
echo   Press any key to close...
pause >nul
