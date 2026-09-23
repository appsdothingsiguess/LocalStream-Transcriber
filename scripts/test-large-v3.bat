@echo off
rem Run large-v3 directly (outside the relay) so the full error output is visible.
rem Usage: scripts\test-large-v3.bat [audio file]   (default: media\ai_voice_2.wav)

cd /d "%~dp0.."

set "PY=C:\Users\john\AppData\Local\Programs\Python\Python313\python.exe"
if not exist "%PY%" set "PY=python"

set "AUDIO=%~1"
if "%AUDIO%"=="" set "AUDIO=media\ai_voice_2.wav"

echo === Transcribing %AUDIO% with large-v3 ===
set "MP3GRABBER_ROOT=%CD%"
set "WHISPER_MODEL=large-v3"
"%PY%" -X faulthandler src\transcribe.py "%AUDIO%"
echo.
echo === Exit code: %ERRORLEVEL% (0 = success, -1073740791 = native crash) ===
pause
