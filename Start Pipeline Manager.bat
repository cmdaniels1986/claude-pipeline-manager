@echo off
title Claude Pipeline Manager
cd /d "%~dp0"

if not exist node_modules (
  echo First run - installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed - see the error above.
    pause
    exit /b 1
  )
)

if not exist node_modules\electron\dist\electron.exe (
  echo Electron binary missing - downloading it now...
  call node node_modules\electron\install.js
  if errorlevel 1 (
    echo.
    echo Electron download failed - are you behind a proxy? See the error above.
    pause
    exit /b 1
  )
)

:loop
call npm run dev
set EXITCODE=%errorlevel%
if exist .update-restart (
  del .update-restart
  echo Restarting after update...
  goto loop
)
if not "%EXITCODE%"=="0" (
  echo.
  echo The app exited with an error - read the output above.
  pause
)
