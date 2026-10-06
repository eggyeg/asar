@echo off
setlocal
title asar setup
set "PS1=%~dp0install.ps1"
if exist "%PS1%" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Bat %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; $ProgressPreference='SilentlyContinue'; $s=(Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/eggyeg/asar/main/install.ps1').Content; & ([scriptblock]::Create($s)) -Bat %*"
)
if errorlevel 1 (
  echo   Setup did not finish. Read the message above.
  pause
  exit /b 1
)
rem Success: close by itself once Discord is starting
timeout /t 4 /nobreak >nul
