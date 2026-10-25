#!/usr/bin/env bash
# Publish the map to GitHub Pages.
#
# Everything in web/ - the pages, the scripts and the exported data - is
# pushed to the gh-pages branch as a single commit that replaces whatever was
# there before. Nothing is added to main's history, so repeating a deploy does
# not grow the repository: the ~20 MB of JSON is rewritten, not accumulated.
#
#   ./deploy.sh            publish what is currently in web/
#   ./deploy.sh --fetch    refresh the data first, then publish
#
# The published studio has no server behind it, so video export falls back to
# in-browser WebM capture. Everything else works as it does locally.
set -euo pipefail

cd "$(dirname "$0")"
BRANCH="gh-pages"

if [ "${1:-}" = "--fetch" ]; then
  echo "Refreshing data..."
  python3 -m src.fetch_all
fi

if [ ! -f web/data/sightings.json ]; then
  echo "No exported data in web/data - run ./run.sh (or ./deploy.sh --fetch) first." >&2
  exit 1
fi

for f in geo.json cities.json; do
  if [ ! -f "web/data/$f" ]; then
    echo "web/data/$f is missing - run: python3 -m src.geodata" >&2
    exit 1
  fi
done

REMOTE=$(git remote get-url origin)
AGE=$(( ( $(date +%s) - $(stat -c %Y web/data/sightings.json) ) / 86400 ))
echo "Data is ${AGE} day(s) old ($(du -sh --apparent-size web/data | cut -f1) total)."

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

cp -r web/. "$STAGE/"
# Stop Pages running the site through Jekyll; it has nothing to do here and
# would skip any file beginning with an underscore.
touch "$STAGE/.nojekyll"

git -C "$STAGE" init -q -b "$BRANCH"
git -C "$STAGE" config core.fileMode false
git -C "$STAGE" add -A
git -C "$STAGE" commit -q -m "Deploy $(date -u '+%Y-%m-%d %H:%M UTC') - data $(date -u -d "@$(stat -c %Y web/data/sightings.json)" '+%Y-%m-%d')"
echo "Pushing $(git -C "$STAGE" ls-files | wc -l) files to ${BRANCH}..."
git -C "$STAGE" push -q -f "$REMOTE" "$BRANCH"

SLUG=$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')
OWNER=${SLUG%%/*}
REPO=${SLUG##*/}
echo
echo "Published. It can take a minute or two to go live:"
echo "  https://${OWNER,,}.github.io/${REPO}/"
