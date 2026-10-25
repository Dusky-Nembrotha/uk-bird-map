"""Fetch every source into the database, then write the map's data files.

    python3 -m src.fetch_all                # normal run
    python3 -m src.fetch_all --deep         # add eBird's per-county-per-day sweep
    python3 -m src.fetch_all --only ebird blogs
    python3 -m src.fetch_all --days 7

Safe to run repeatedly (from cron, say): records upsert on a stable id, so a
re-run refreshes rather than duplicates.
"""
import argparse
import sys
import time

from . import db, gazetteer, geodata, species
from .config import CFG
from .sources import (birdweather, blogs, bluesky, countyrecorders, ebird,
                      gbif, inaturalist, weather)
from .util import iso_now, log, setup_logging, since_date

# Sources whose rows are replaced wholesale each run. Blogs are re-read from
# the same posts every time, and acoustic records are aggregates over a moving
# window, so yesterday's rows are duplicates rather than extra coverage. The
# checklist sources are left to accumulate: a record seen yesterday but not
# today still happened.
REPLACE_WHOLESALE = {"blogs": "blog", "birdweather": "birdweather",
                     "bluesky": "bluesky",
                     "countyrecorders": "countyrecorder"}

SOURCES = {
    "ebird": ebird,
    "inaturalist": inaturalist,
    "birdweather": birdweather,
    "gbif": gbif,
    "blogs": blogs,
    "bluesky": bluesky,
    "countyrecorders": countyrecorders,
}


def run(only=None, days=None, deep=False, rebuild=False, prune=True,
        export=True, max_posts=40, studio=True):
    started = iso_now()
    db.init()

    log.info("building species index")
    species.build(force=rebuild)

    enabled = [s for s in SOURCES
               if (only and s in only) or (not only and CFG["sources"].get(s))]
    log.info("sources: %s", ", ".join(enabled) or "(none)")

    # The gazetteer needs eBird locations, so blogs run last and the gazetteer
    # is built just before them.
    text_sources = ("blogs", "bluesky", "countyrecorders")
    ordered = [s for s in enabled if s not in text_sources] + \
              [s for s in enabled if s in text_sources]

    totals = {}
    for name in ordered:
        mod = SOURCES[name]
        t0 = time.time()
        if name in ("blogs", "bluesky"):
            gazetteer.build(force=rebuild)
        try:
            if name == "ebird":
                rows = mod.fetch(deep=deep, days_back=days)
            elif name == "blogs":
                rows = mod.fetch(days_back=days, max_posts=max_posts)
            elif name in ("bluesky", "countyrecorders"):
                rows = mod.fetch(days_back=days)
            else:
                rows = mod.fetch(days_back=days)
        except Exception as e:  # noqa: BLE001 - one bad source must not stop the rest
            log.exception("%s: failed (%s)", name, e)
            with db.db() as conn:
                db.log_run(conn, started, name, 0, 0, f"failed: {e}")
            continue

        with db.db() as conn:
            if name in REPLACE_WHOLESALE and rows:
                gone = db.delete_source(conn, REPLACE_WHOLESALE[name])
                if gone:
                    log.info("%s: cleared %d previous rows", name, gone)
            written = db.upsert_sightings(conn, rows)
            db.log_run(conn, started, name, len(rows), written,
                       f"{time.time() - t0:.0f}s")
        totals[name] = written
        log.info("%s: %d records stored (%.0fs)", name, written, time.time() - t0)

    if prune:
        # The widest window of any source decides the cutoff, otherwise GBIF's
        # deliberately longer reach would be pruned away the moment it landed.
        widest = max(days or CFG["days_back"],
                     CFG["gbif"].get("days_back") or 0)
        cutoff = since_date(widest).isoformat()
        with db.db() as conn:
            gone = db.prune_older_than(conn, cutoff)
        if gone > 0:
            log.info("pruned %d records older than %s", gone, cutoff)

    with db.db() as conn:
        by_source = db.counts_by_source(conn)
        total = sum(by_source.values())
    log.info("database holds %d records: %s", total, by_source)

    # The studio draws its own world and can overlay weather; both are
    # independent of the sighting fetch, so a failure here is not fatal.
    if studio:
        try:
            geodata.build(force=rebuild)
        except Exception as e:  # noqa: BLE001
            log.warning("geodata: failed (%s)", e)
        try:
            weather.fetch(days_back=days)
        except Exception as e:  # noqa: BLE001
            log.warning("weather: failed (%s)", e)

    if export:
        from . import export_web
        export_web.export()
    return totals


def main(argv=None):
    p = argparse.ArgumentParser(description="Fetch UK bird sightings")
    p.add_argument("--only", nargs="+", choices=sorted(SOURCES),
                   help="fetch only these sources")
    p.add_argument("--days", type=int, help="days back (default from config)")
    p.add_argument("--deep", action="store_true",
                   help="eBird per-county-per-day sweep: many more records, "
                        "much slower")
    p.add_argument("--max-posts", type=int, default=40,
                   help="blog posts to read per blog (default 40)")
    p.add_argument("--rebuild", action="store_true",
                   help="rebuild the species index and gazetteer")
    p.add_argument("--no-prune", action="store_true",
                   help="keep records older than the window")
    p.add_argument("--no-export", action="store_true",
                   help="do not rewrite the map data files")
    p.add_argument("--no-studio", action="store_true",
                   help="skip the animation studio's map and weather data")
    p.add_argument("-v", "--verbose", action="store_true")
    a = p.parse_args(argv)

    setup_logging(a.verbose)
    run(only=set(a.only) if a.only else None, days=a.days, deep=a.deep,
        rebuild=a.rebuild, prune=not a.no_prune, export=not a.no_export,
        max_posts=a.max_posts, studio=not a.no_studio)
    return 0


if __name__ == "__main__":
    sys.exit(main())
