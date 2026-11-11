@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
start "OEE server - close this window to stop" node server.js
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
