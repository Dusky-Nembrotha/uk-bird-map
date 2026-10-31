"""A year of one species, from GBIF, into its own database.

The live pipeline keeps a rolling month and prunes anything older, which is
right for "what is about this week" and useless for migration: a bird's year
is the whole point. So this writes somewhere the pruner cannot reach -
data/migration.db - and nothing in the normal fetch touches it.

It also inverts one of the live fetcher's rules. src/sources/gbif.py drops
records GBIF flags as originating from eBird, because eBird arrives fresher
through its own API; over a year that reasoning runs backwards, since the
eBird Observation Dataset on GBIF *is* the historical record and our live
eBird adapter only ever saw the last fortnight.

    python3 -m src.backfill --species "Pink-footed Goose"
    python3 -m src.backfill --sci "Anser brachyrhynchus" --months 12
"""
import argparse
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from .config import AREA_BBOX, DATA
from .util import RateLimiter, log, parse_date, request_json, setup_logging

SEARCH = "https://api.gbif.org/v1/occurrence/search"
MATCH = "https://api.gbif.org/v1/species/match"
PAGE = 300
# GBIF refuses to page past this, which is why the window is sliced by month
# rather than asked for whole.
MAX_OFFSET = 100_000

DB_PATH = DATA / "migration.db"
_limiter = RateLimiter(0.4)
_limiter_lock = threading.Lock()


class _Paced:
    """The shared limiter, made safe to call from several threads."""

    def wait(self):
        with _limiter_lock:
            _limiter.wait()


_paced = _Paced()

# GBIF's latency wanders between half a second and six seconds a page for no
# reason visible from here, and a year of a common species is hundreds of
# pages. Months are fetched a few at a time so a slow spell costs wall clock
# instead of the whole run. The shared limiter still paces every request, so
# this overlaps waiting rather than raising the rate.
WORKERS = 6

SCHEMA = """
CREATE TABLE IF NOT EXISTS occurrence (
  uid         TEXT PRIMARY KEY,
  species_key INTEGER NOT NULL,
  sci         TEXT NOT NULL,
  common      TEXT,
  obs_date    TEXT NOT NULL,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  count       INTEGER,
  dataset     TEXT,
  locality    TEXT
);
CREATE INDEX IF NOT EXISTS occ_sp_date ON occurrence (species_key, obs_date);
"""


def connect():
    DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    # Added after the first backfills had already run.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(occurrence)")}
    if "locality" not in cols:
        conn.execute("ALTER TABLE occurrence ADD COLUMN locality TEXT")
    return conn


def taxon_key(name):
    d = request_json("GET", MATCH, params={"name": name}, limiter=_limiter,
                     timeout=60) or {}
    if d.get("matchType") == "NONE" or not d.get("usageKey"):
        raise SystemExit(f"GBIF does not know a species called {name!r}")
    if d.get("rank") != "SPECIES":
        log.warning("%s matched at rank %s (%s)", name, d.get("rank"),
                    d.get("scientificName"))
    return d["usageKey"], d.get("scientificName", name), d.get("canonicalName", name)


def _polygon():
    b = AREA_BBOX
    return (f"POLYGON(({b['west']} {b['south']},{b['east']} {b['south']},"
            f"{b['east']} {b['north']},{b['west']} {b['north']},"
            f"{b['west']} {b['south']}))")


def _month_edges(months=None, start=None, end=None):
    """Month boundaries, oldest first.

    Either a count of months back from today, or an explicit window - which is
    what you want in practice, because the window worth building on is a
    complete year that ended before GBIF's publication lag begins.
    """
    if start and end:
        a, b = date.fromisoformat(start), date.fromisoformat(end)
        edges, cur = [a], a.replace(day=1)
        while cur <= b:
            nxt = (cur + timedelta(days=32)).replace(day=1)
            edges.append(min(nxt, b))
            cur = nxt
        return sorted(set(edges))
    today = date.today()
    edges = [today]
    cur = today.replace(day=1)
    for _ in range(months or 12):
        edges.append(cur)
        cur = (cur - timedelta(days=1)).replace(day=1)
    return list(reversed(edges))


def _rows(key, start, end):
    """Every occurrence of one species in one month window."""
    out, offset = [], 0
    while offset < MAX_OFFSET:
        data = request_json("GET", SEARCH, limiter=_paced, timeout=120, params={
            "taxonKey": key,
            "hasCoordinate": "true",
            "hasGeospatialIssue": "false",
            "eventDate": f"{start.isoformat()},{end.isoformat()}",
            "geometry": _polygon(),
            "limit": PAGE,
            "offset": offset,
        })
        if not data:
            break
        for rec in data.get("results", []):
            lat, lon = rec.get("decimalLatitude"), rec.get("decimalLongitude")
            obs = parse_date(rec.get("eventDate"))
            if lat is None or lon is None or not obs:
                continue
            n = rec.get("individualCount")
            out.append((f"gbif:{rec.get('key')}", key,
                        rec.get("species") or rec.get("scientificName") or "",
                        rec.get("vernacularName"), obs, float(lat), float(lon),
                        n if isinstance(n, int) else None,
                        rec.get("datasetName"),
                        rec.get("locality") or rec.get("verbatimLocality")))
        if data.get("endOfRecords") or not data.get("results"):
            break
        offset += PAGE
    return out


def backfill(name, months=12, start=None, end=None):
    key, sci, canonical = taxon_key(name)
    log.info("%s -> GBIF taxon %s (%s)", name, key, sci)
    conn = connect()
    edges = _month_edges(months, start, end)
    total = 0
    windows = list(zip(edges, edges[1:]))
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(_rows, key, a, b): a for a, b in windows}
        # Written back in calendar order whatever order they land in, so the
        # log reads as a year rather than as a race. SQLite is touched only
        # here, on one thread.
        for a, fut in sorted(((a, f) for f, a in futures.items()),
                             key=lambda t: t[0]):
            rows = fut.result()
            with conn:
                conn.executemany(
                    "INSERT INTO occurrence (uid, species_key, sci, common,"
                    " obs_date, lat, lon, count, dataset, locality)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?)"
                    " ON CONFLICT(uid) DO UPDATE SET"
                    " locality = COALESCE(excluded.locality, occurrence.locality)",
                    rows)
            total += len(rows)
            log.info("  %s  %6d records", a.isoformat()[:7], len(rows))
    held = conn.execute("SELECT COUNT(*) FROM occurrence WHERE species_key = ?",
                        (key,)).fetchone()[0]
    span = conn.execute("SELECT MIN(obs_date), MAX(obs_date) FROM occurrence"
                        " WHERE species_key = ?", (key,)).fetchone()
    log.info("%s: fetched %d, database holds %d spanning %s to %s",
             canonical, total, held, span[0], span[1])
    conn.close()
    return key


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--species", "--sci", dest="species", required=True,
                    nargs="+",
                    help="one or more names, e.g. 'Anser brachyrhynchus'")
    ap.add_argument("--months", type=int, default=12)
    ap.add_argument("--from", dest="start", help="YYYY-MM-DD")
    ap.add_argument("--to", dest="end", help="YYYY-MM-DD")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    setup_logging(a.verbose)
    for name in a.species:
        try:
            backfill(name, a.months, a.start, a.end)
        except SystemExit as e:
            log.error("%s: %s", name, e)


if __name__ == "__main__":
    main()
