#!/usr/bin/env bash
# Fetch the latest sightings and serve the map and animation studio.
#
#   ./run.sh               fetch, then serve on http://localhost:8777
#   ./run.sh --serve-only  skip fetching
#   ./run.sh --deep        slower eBird sweep, many more records
set -euo pipefail

cd "$(dirname "$0")"
PORT="${PORT:-8777}"
FETCH_ARGS=()
SERVE_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --serve-only) SERVE_ONLY=1 ;;
    *) FETCH_ARGS+=("$arg") ;;
  esac
done

if [ "$SERVE_ONLY" -eq 0 ]; then
  echo "Fetching sightings..."
  python3 -m src.fetch_all ${FETCH_ARGS[@]+"${FETCH_ARGS[@]}"}
fi

if [ ! -f web/data/sightings.json ]; then
  echo "No data yet - run without --serve-only first." >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Note: ffmpeg is not installed, so the studio cannot export video."
  echo "      sudo apt install ffmpeg"
fi

echo
echo "  Map     http://localhost:${PORT}/"
echo "  Studio  http://localhost:${PORT}/studio.html"
echo
echo "Press Ctrl-C to stop."
exec python3 -m src.server --port "$PORT"
