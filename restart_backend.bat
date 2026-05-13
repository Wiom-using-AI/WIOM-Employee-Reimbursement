@echo off
echo Stopping backend on port 8003...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8003.*LISTENING"') do (
    echo Killing PID %%a
    taskkill /F /PID %%a 2>nul
)
timeout /t 2 /nobreak >nul
echo Starting fresh backend...
cd /d "C:\Users\Tushar Gupta\Desktop\Claude Working Agent 1\expense-validator\backend"
start "Expense Validator Backend" python -m uvicorn main:app --host 0.0.0.0 --port 8003 --log-level warning
echo.
echo Backend restarted! Wait 3-4 seconds then refresh the browser.
pause
