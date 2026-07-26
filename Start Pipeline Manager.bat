@echo off
title Claude Pipeline Manager
cd /d "%~dp0"
:loop
call npm run dev
if exist .update-restart (
  del .update-restart
  echo Restarting after update...
  goto loop
)
