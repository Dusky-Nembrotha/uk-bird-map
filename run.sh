#!/usr/bin/env bash
# Fetch the latest sightings and serve the map and animation studio.
#
#   ./run.sh               fetch, then serve on http://localhost:8777
#   ./run.sh --serve-only  skip fetching
#   ./run.sh --deep        slower eBird sweep, many more records
#
# The migration view is fed separately and on its own cadence - it reads years
# rather than the rolling month this pipeline keeps, so it is not rebuilt on
# every fetch:
#
#   python3 -m src.backfill  --species "Anser brachyrhynchus" \
#                            --from 2024-09-01 --to 2025-08-31
#   python3 -m src.migration --from 2024-09-01 --to 2025-08-31
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
echo "  Animation  http://localhost:${PORT}/"
echo "  Tile map   http://localhost:${PORT}/map.html"
if [ -d web/data/migration ] && [ -n "$(ls -A web/data/migration 2>/dev/null)" ]; then
  echo "  A year     http://localhost:${PORT}/migration.html"
else
  echo "  A year     http://localhost:${PORT}/migration.html  (no data yet - see the"
  echo "             backfill commands at the top of this script)"
fi
echo
echo "Press Ctrl-C to stop."
exec python3 -m src.server --port "$PORT"
