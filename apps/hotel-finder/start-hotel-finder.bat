@echo off
cd /d "%~dp0"
echo Starting Hotel Finder server...
start "" http://localhost:3000
node --env-file=.env server.js
pause
