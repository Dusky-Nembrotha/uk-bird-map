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

# Deploy through Actions rather than the legacy branch builder.
#
# The legacy builder began returning "Page build failed" with no further
# detail, repeatedly, on a tree whose only change from the last good build was
# one JavaScript file - which it does not parse. The content was valid UTF-8,
# carried .nojekyll, held no Liquid syntax, was nowhere near the size limits,
# and GitHub reported no incident. With nothing to diagnose, the answer is to
# stop depending on it: this workflow takes the same branch and publishes it
# through the Actions pipeline, which does report what went wrong.
mkdir -p "$STAGE/.github/workflows"
cat > "$STAGE/.github/workflows/pages.yml" <<'YML'
name: Deploy site

on:
  push:
    branches: [gh-pages]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

# Never two at once: this branch is force-pushed on every deploy.
concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Stage the site without its plumbing
        run: |
          mkdir -p _site
          rsync -a --exclude .git --exclude .github --exclude _site ./ _site/
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: _site
      - id: deployment
        uses: actions/deploy-pages@v4
YML

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
