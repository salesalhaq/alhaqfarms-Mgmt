@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing bridge dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)
echo Starting Al Haq Local Bridge on ws://127.0.0.1:47654
node server.cjs
