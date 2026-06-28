@echo off
cd /d "%~dp0"
echo Starting Hotel Info server...
start "" http://localhost:3001
node --env-file=.env server.js
pause
