"""SQLite store for sightings, the species list and the site gazetteer.

Every row carries a stable `uid` so repeated runs upsert rather than duplicate,
which lets the fetchers be run as often as you like (e.g. from cron).
"""
import json
import sqlite3
from contextlib import contextmanager

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS sighting (
    uid         TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    common      TEXT,
    sci         TEXT,
    species_key TEXT,
    count       INTEGER,
    obs_date    TEXT NOT NULL,
    obs_time    TEXT,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    precision   TEXT NOT NULL DEFAULT 'exact',
    site        TEXT,
    region      TEXT,
    observer    TEXT,
    url         TEXT,
    confidence  REAL,
    notable     INTEGER NOT NULL DEFAULT 0,
    extra       TEXT,
    fetched_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_sighting_date    ON sighting(obs_date);
CREATE INDEX IF NOT EXISTS ix_sighting_species ON sighting(species_key);
CREATE INDEX IF NOT EXISTS ix_sighting_source  ON sighting(source);

CREATE TABLE IF NOT EXISTS species (
    species_key TEXT PRIMARY KEY,
    common      TEXT,
    sci         TEXT,
    uk_records  INTEGER DEFAULT 0,
    aliases     TEXT,
    photo       TEXT,
    photo_credit TEXT
);

CREATE TABLE IF NOT EXISTS gazetteer (
    name_key TEXT NOT NULL,
    name     TEXT NOT NULL,
    lat      REAL NOT NULL,
    lon      REAL NOT NULL,
    region   TEXT,
    kind     TEXT,
    weight   REAL DEFAULT 1.0,
    origin   TEXT,
    PRIMARY KEY (name_key, lat, lon)
);
CREATE INDEX IF NOT EXISTS ix_gaz_name ON gazetteer(name_key);

-- Persistent cache of Nominatim answers, so a site name is only ever
-- geocoded online once (misses are cached too, as empty rows).
CREATE TABLE IF NOT EXISTS geocode_cache (
    query     TEXT PRIMARY KEY,
    lat       REAL,
    lon       REAL,
    name      TEXT,
    queried_at TEXT
);

CREATE TABLE IF NOT EXISTS run_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT,
    source     TEXT,
    fetched    INTEGER,
    inserted   INTEGER,
    note       TEXT
);
"""

FIELDS = ("uid", "source", "common", "sci", "species_key", "count", "obs_date",
          "obs_time", "lat", "lon", "precision", "site", "region", "observer",
          "url", "confidence", "notable", "extra", "fetched_at")


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# Columns added after the first release; applied to existing databases so an
# upgrade does not need the data refetching.
MIGRATIONS = [
    ("species", "photo", "TEXT"),
    ("species", "photo_credit", "TEXT"),
]


def init():
    with db() as conn:
        conn.executescript(SCHEMA)
        for table, column, decl in MIGRATIONS:
            have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            if column not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def upsert_sightings(conn, rows):
    """Insert or replace sighting dicts. Returns the number of rows written."""
    payload = []
    for r in rows:
        if r.get("lat") is None or r.get("lon") is None or not r.get("obs_date"):
            continue
        extra = r.get("extra")
        rec = dict(r)
        rec["extra"] = json.dumps(extra) if isinstance(extra, (dict, list)) else extra
        payload.append(tuple(rec.get(f) for f in FIELDS))
    if not payload:
        return 0
    sql = (f"INSERT INTO sighting ({','.join(FIELDS)}) "
           f"VALUES ({','.join('?' * len(FIELDS))}) "
           f"ON CONFLICT(uid) DO UPDATE SET "
           + ",".join(f"{f}=excluded.{f}" for f in FIELDS if f != "uid"))
    conn.executemany(sql, payload)
    return len(payload)


def delete_source(conn, source):
    """Remove every row for a source. Used for sources that are fully
    re-enumerated on each run (blogs, acoustic aggregates), where a stale row
    is a duplicate rather than extra coverage."""
    cur = conn.execute("DELETE FROM sighting WHERE source = ?", (source,))
    return cur.rowcount


def log_run(conn, started_at, source, fetched, inserted, note=""):
    conn.execute(
        "INSERT INTO run_log (started_at, source, fetched, inserted, note) "
        "VALUES (?,?,?,?,?)", (started_at, source, fetched, inserted, note))


def prune_older_than(conn, cutoff_date):
    cur = conn.execute("DELETE FROM sighting WHERE obs_date < ?", (cutoff_date,))
    return cur.rowcount


def counts_by_source(conn):
    return {r["source"]: r["n"] for r in conn.execute(
        "SELECT source, COUNT(*) n FROM sighting GROUP BY source ORDER BY n DESC")}
