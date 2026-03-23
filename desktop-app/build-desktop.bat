@echo off
echo ============================================
echo   Command Communications Desktop Build
echo ============================================
echo.

cd /d "%~dp0"

echo [1/3] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

echo.
echo [2/3] Building Windows installer...
call npm run dist:win
if %ERRORLEVEL% neq 0 (
    echo ERROR: Build failed
    pause
    exit /b 1
)

echo.
echo [3/3] Done!
echo.
echo Installer is in: dist\
echo.
dir dist\*.exe 2>nul
pause
