@echo off
:: TigrimOS - Windows Installer Launcher
:: Double-click this file to install TigrimOS

title TigrimOS Installer

echo.
echo   ========================================
echo      TigrimOS - Windows Installer
echo   ========================================
echo.
echo   Starting installer, please wait...
echo.

:: Launch PowerShell with bypass policy to run the install script
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0install_windows.ps1"

if %ERRORLEVEL% neq 0 (
    echo.
    echo   Installation encountered an error.
    echo   Press any key to close...
    pause >nul
)
