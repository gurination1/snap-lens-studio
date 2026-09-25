@echo off
title SnapAR Studio • Web Lens Tester
cd /d "%~dp0"

echo ========================================================
echo  SnapAR Studio • Web Lens Tester & Inspector
echo ========================================================
echo.

python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in PATH!
    echo Please download and install Python from https://www.python.org/downloads/
    echo Make sure to check "Add Python to PATH" during installation.
    echo.
    pause
    exit /b 1
)

echo [1/2] Checking Python dependencies...
python -m pip install -r requirements.txt --quiet --disable-pip-version-check

echo [2/2] Launching SnapAR Studio on http://localhost:8888...
timeout /t 2 /nobreak >nul
start http://localhost:8888

python app.py --port 8888
pause
