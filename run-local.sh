#!/usr/bin/env sh
set -eu

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
. .venv/bin/activate
python -m pip install -r requirements.txt
exec python -m uvicorn api:app --host "${HOST:-0.0.0.0}" --port "${PORT:-3000}"
