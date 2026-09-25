#!/usr/bin/env bash
set -e

PORT=${1:-8888}
HOST=${2:-0.0.0.0}

cd "$(dirname "$0")"

echo "👻 Starting SnapAR Studio • Web Lens Tester on http://${HOST}:${PORT}"
exec python3 app.py --host "${HOST}" --port "${PORT}"
