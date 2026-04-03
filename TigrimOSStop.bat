@echo off
:: TigrimOS - Stop Application (Windows / WSL2)
title TigrimOS - Stopping...

echo.
echo   ========================================
echo      TigrimOS - Stopping
echo   ========================================
echo.

wsl -d TigrimOS -- bash -c "pkill -f 'node.*server' 2>/dev/null; pkill -f 'tsx.*index' 2>/dev/null; echo 'Server stopped.'"

echo.
echo   TigrimOS has been stopped.
echo   Press any key to close...
pause >nul
