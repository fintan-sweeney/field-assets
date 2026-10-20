@echo off
REM Daily sync for Windows Task Scheduler.
REM Uses ArcGIS Pro's Python if present, otherwise "python" on the PATH.
REM Secrets can be set as system environment variables instead of in config.json:
REM   ARCGIS_PASSWORD, SUPABASE_SECRET_KEY

cd /d "%~dp0"
set PY="C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe"
if not exist %PY% set PY=python

if not exist logs mkdir logs
%PY% arcgis_sync.py >> "logs\sync.log" 2>&1
exit /b %ERRORLEVEL%
