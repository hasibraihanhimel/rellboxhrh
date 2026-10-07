@echo off
setlocal
if not defined PORT set PORT=3000
if not exist .venv\Scripts\python.exe python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn api:app --host 0.0.0.0 --port %PORT%
