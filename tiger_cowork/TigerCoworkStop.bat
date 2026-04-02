@echo off
:: Tiger Cowork - Stop Container
title Tiger Cowork - Stopping...

echo.
echo   ========================================
echo      Tiger Cowork - Stopping
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

:: Find the TigerCowork install directory
:: First check if we're in the install directory (has docker-compose.yml)
if exist "%~dp0docker-compose.yml" (
    set "INSTALL_DIR=%~dp0"
    goto :stop_app
)

:: Check default install location
if exist "C:\TigerCowork\docker-compose.yml" (
    set "INSTALL_DIR=C:\TigerCowork"
    goto :stop_app
)

echo   [ERROR] Cannot find Tiger Cowork installation.
echo   Please run this script from the Tiger Cowork install directory.
echo.
pause
exit /b 1

:stop_app
echo   Stopping Tiger Cowork...
echo.

pushd "%INSTALL_DIR%"
"%DOCKER_CMD%" compose down
popd

if %ERRORLEVEL% equ 0 (
    echo.
    echo   Tiger Cowork has been stopped.
) else (
    echo.
    echo   There was a problem stopping Tiger Cowork.
)

echo.
echo   Press any key to close...
pause >nul
