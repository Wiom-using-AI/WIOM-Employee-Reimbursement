@echo off
title Expense Validator
setlocal

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "PORT=8003"
set "URL=http://127.0.0.1:%PORT%"

:: ── Kill any existing process on our port ─────────────────────────────────
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":%PORT% "') do (
    taskkill /PID %%p /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: ── Activate virtual environment if present ────────────────────────────────
if exist "%BACKEND%\venv\Scripts\activate.bat" (
    call "%BACKEND%\venv\Scripts\activate.bat"
) else if exist "%ROOT%venv\Scripts\activate.bat" (
    call "%ROOT%venv\Scripts\activate.bat"
)

:: ── Start the backend server (hidden window) ───────────────────────────────
start "" /min cmd /c "cd /d "%BACKEND%" && uvicorn main:app --host 127.0.0.1 --port %PORT% --log-level warning"

:: ── Wait until the server responds (up to 30 s) ────────────────────────────
echo Starting Expense Validator...
set /a tries=0
:wait_loop
timeout /t 1 /nobreak >nul
curl -s -o nul -w "%%{http_code}" "%URL%/docs" 2>nul | findstr "200" >nul && goto :ready
set /a tries+=1
if %tries% lss 30 goto :wait_loop
echo Server did not start in time. Opening anyway...

:ready
:: ── Open the app in the default browser ────────────────────────────────────
start "" "%URL%"
echo Expense Validator is running at %URL%
echo Close this window to keep the server running in the background.
