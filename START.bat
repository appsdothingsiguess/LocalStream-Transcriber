@echo off
cd /d "%~dp0"
powershell -NoExit -Command "npm run setup"
