@echo off
cd /d "%~dp0"

rem Already inside Windows Terminal — run directly
if defined WT_SESSION goto :run

rem Windows Terminal available — relaunch inside it (emoji + clickable links)
where wt >nul 2>&1
if not errorlevel 1 (
    wt -d . cmd /k npm run setup
    goto :eof
)

rem Fallback: plain cmd (limited emoji, no clickable links)
:run
chcp 65001 >nul
npm run setup
