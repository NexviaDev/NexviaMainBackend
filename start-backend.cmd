@echo off
cd /d "%~dp0"
echo Starting backend with nodemon (use CMD if Git Bash hides Node errors)...
call npx nodemon app.js
pause
