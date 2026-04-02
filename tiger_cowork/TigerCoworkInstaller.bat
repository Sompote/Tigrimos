@echo off
:: Tiger Cowork Installer - Windows Launcher
:: Double-click this file to start the installation

title Tiger Cowork Installer

echo.
echo   ========================================
echo      Tiger Cowork Installer
echo   ========================================
echo.
echo   Starting installer, please wait...
echo.

:: Launch PowerShell with bypass policy to run the install script
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0install.ps1"

if %ERRORLEVEL% neq 0 (
    echo.
    echo   Installation encountered an error.
    echo   Press any key to close...
    pause >nul
)
