#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "========================================================"
echo "👻 SnapAR Studio • Web Lens Tester & Inspector"
echo "========================================================"
echo ""

if ! command -v python3 &> /dev/null; then
    echo "[ERROR] python3 could not be found. Please install Python 3."
    exit 1
fi

echo "[1/2] Checking Python dependencies..."
python3 -m pip install -r requirements.txt --quiet --disable-pip-version-check 2>/dev/null || true

echo "[2/2] Launching SnapAR Studio on http://localhost:8888..."
(sleep 1.5 && (which xdg-open >/dev/null 2>&1 && xdg-open http://localhost:8888 || which open >/dev/null 2>&1 && open http://localhost:8888 || true)) &

exec python3 app.py --port 8888
