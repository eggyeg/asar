@echo off
setlocal
title asar installer
set "PS1=%~dp0install.ps1"
if exist "%PS1%" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; $ProgressPreference='SilentlyContinue'; $s=(Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/eggyeg/asar/main/install.ps1').Content; & ([scriptblock]::Create($s)) %*"
)
echo.
pause
