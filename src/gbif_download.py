"""Fetch whole species-years from GBIF through the download API.

    python3 -m src.gbif_download --species "Turdus iliacus" "Grus grus" \
                                 --from 2024-09-01 --to 2025-08-31

Why this exists rather than src.backfill: the occurrence/search API is paged,
and GBIF throttles sustained paging hard. After a few hours of backfilling, a
query that returned in 0.58s was taking over 420 seconds, and restarting did
not clear it. The search API also refuses to page past offset 100,000, so any
species with more than that in one month was being silently truncated - which
would quietly ruin Wood Pigeon and Blackcap.

The download API is what GBIF provides for this. You post a predicate, it
prepares a zip server-side, and you fetch one file. It needs a free GBIF
account because every download is registered and given a DOI.

    config.json:  {"gbif": {"username": "...", "password": "..."}}
    or:           GBIF_USER / GBIF_PASS in the environment

All the requested species go into ONE download. GBIF charges the same wait for
one species or twenty, so asking separately wastes the whole afternoon.

Downloads are slow to prepare - minutes, sometimes longer for big predicates -
and the key survives the process. If this is interrupted, resume with:

    python3 -m src.gbif_download --key 0012345-250101000000000
"""
import argparse
import csv
import io
import os
import sys
import time
import zipfile

from .backfill import connect, taxon_key, _polygon
from .config import CACHE, CFG
from .util import log, parse_date, session, setup_logging

API = "https://api.gbif.org/v1/occurrence/download"
REQUEST = f"{API}/request"

# GBIF prepares a download asynchronously. These are polled, not guessed:
# small predicates come back in a minute or two, big ones take considerably
# longer, so the wait backs off rather than hammering.
POLL_FIRST = 20
POLL_MAX = 120
POLL_GIVE_UP = 3 * 3600

RUNNING = {"PREPARING", "RUNNING", "SUSPENDED"}
FAILED = {"KILLED", "CANCELLED", "FAILED", "FILE_ERASED"}


def credentials():
    gb = CFG.get("gbif") or {}
    user = os.environ.get("GBIF_USER") or gb.get("username") or ""
    pw = os.environ.get("GBIF_PASS") or gb.get("password") or ""
    if user.startswith("PUT_YOUR"):
        user = ""
    if not user or not pw:
        raise SystemExit(
            "The download API needs a free GBIF account.\n"
            "  1. Register at https://www.gbif.org/user/profile\n"
            "  2. Put it in config.json (which is gitignored):\n"
            '       {"gbif": {"username": "...", "password": "..."}}\n'
            "     or set GBIF_USER and GBIF_PASS in the environment.")
    return user, pw


def predicate(keys, start, end):
    """One predicate covering every species asked for."""
    return {
        "type": "and",
        "predicates": [
            {"type": "in", "key": "TAXON_KEY", "values": [str(k) for k in keys]},
            {"type": "equals", "key": "HAS_COORDINATE", "value": "true"},
            {"type": "equals", "key": "HAS_GEOSPATIAL_ISSUE", "value": "false"},
            {"type": "within", "geometry": _polygon()},
            {"type": "greaterThanOrEquals", "key": "EVENT_DATE", "value": start},
            {"type": "lessThanOrEquals", "key": "EVENT_DATE", "value": end},
        ],
    }


def request_download(keys, start, end, email=None):
    user, pw = credentials()
    body = {
        "creator": user,
        "format": "SIMPLE_CSV",
        "predicate": predicate(keys, start, end),
    }
    if email:
        body["notificationAddresses"] = [email]
    r = session().post(REQUEST, json=body, auth=(user, pw), timeout=120)
    if r.status_code in (401, 403):
        raise SystemExit("GBIF rejected those credentials (HTTP "
                         f"{r.status_code}). Check the username and password.")
    r.raise_for_status()
    # The response body is the bare download key, not JSON.
    return r.text.strip()


def wait_for(key):
    """Poll until the download is built. Returns the metadata."""
    user, pw = credentials()
    waited, gap = 0, POLL_FIRST
    while True:
        r = session().get(f"{API}/{key}", auth=(user, pw), timeout=120)
        r.raise_for_status()
        meta = r.json()
        status = meta.get("status")
        if status == "SUCCEEDED":
            log.info("download %s ready: %s records, %.1f MB", key,
                     f"{meta.get('totalRecords', 0):,}",
                     (meta.get("size") or 0) / 1e6)
            return meta
        if status in FAILED:
            raise SystemExit(f"GBIF download {key} ended as {status}")
        if status not in RUNNING:
            log.warning("unfamiliar status %r for %s", status, key)
        if waited > POLL_GIVE_UP:
            raise SystemExit(
                f"download {key} still {status} after {waited // 60} minutes. "
                f"It is not lost - resume with --key {key}")
        log.info("  %s after %dm; waiting %ds", status, waited // 60, gap)
        time.sleep(gap)
        waited += gap
        gap = min(POLL_MAX, int(gap * 1.5))


def fetch_zip(meta, key):
    path = CACHE / f"gbif-{key}.zip"
    if path.exists() and path.stat().st_size > 0:
        log.info("using the copy already in the cache: %s", path)
        return path
    url = meta.get("downloadLink") or f"{API}/request/{key}.zip"
    log.info("downloading %s", url)
    with session().get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        tmp = path.with_suffix(".part")
        got = 0
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
                got += len(chunk)
                if got % (32 << 20) < (1 << 20):
                    log.info("  %.0f MB", got / 1e6)
        tmp.rename(path)
    return path


def rows_from(path):
    """SIMPLE_CSV is one tab-separated file inside the zip.

    It carries no vernacular name and no dataset title - only a datasetKey.
    That is no loss: the vernacular GBIF returns is whichever language the
    publishing dataset used, which is why the database already held
    'spetsbergsgas' and 'bergfink'. English names come from our own species
    index instead, in src.migration._english_name.
    """
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if n.endswith(".csv")]
        if not names:
            raise SystemExit(f"no csv inside {path}")
        with z.open(names[0]) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8", newline="")
            # Occurrence remarks can contain stray quotes; QUOTE_NONE keeps the
            # reader from swallowing the rest of the file when they do.
            for rec in csv.DictReader(text, delimiter="\t", quoting=csv.QUOTE_NONE):
                lat, lon = rec.get("decimalLatitude"), rec.get("decimalLongitude")
                obs = parse_date(rec.get("eventDate"))
                key = rec.get("speciesKey") or rec.get("taxonKey")
                if not lat or not lon or not obs or not key:
                    continue
                try:
                    lat, lon, key = float(lat), float(lon), int(key)
                except ValueError:
                    continue
                n = rec.get("individualCount")
                try:
                    n = int(n) if n not in (None, "") else None
                except ValueError:
                    n = None
                yield (f"gbif:{rec.get('gbifID')}", key,
                       rec.get("species") or rec.get("scientificName") or "",
                       None, obs, lat, lon, n,
                       rec.get("datasetKey"), rec.get("locality") or None)


def store(path):
    conn = connect()
    total = 0
    batch = []
    SQL = ("INSERT INTO occurrence (uid, species_key, sci, common, obs_date,"
           " lat, lon, count, dataset, locality) VALUES (?,?,?,?,?,?,?,?,?,?)"
           " ON CONFLICT(uid) DO UPDATE SET"
           " locality = COALESCE(excluded.locality, occurrence.locality)")
    for row in rows_from(path):
        batch.append(row)
        if len(batch) >= 20000:
            with conn:
                conn.executemany(SQL, batch)
            total += len(batch)
            log.info("  stored %s", f"{total:,}")
            batch = []
    if batch:
        with conn:
            conn.executemany(SQL, batch)
        total += len(batch)
    log.info("stored %s records", f"{total:,}")
    for sci, n, lo, hi in conn.execute(
            "SELECT sci, COUNT(*), MIN(obs_date), MAX(obs_date) FROM occurrence"
            " GROUP BY sci ORDER BY COUNT(*) DESC LIMIT 40"):
        log.info("  %-34s %8s  %s to %s", sci, f"{n:,}", lo, hi)
    conn.close()
    return total


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--species", nargs="+", help="scientific names")
    ap.add_argument("--from", dest="start", default="2024-09-01")
    ap.add_argument("--to", dest="end", default="2025-08-31")
    ap.add_argument("--key", help="resume a download already requested")
    ap.add_argument("--email", help="have GBIF email you when it is ready")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    setup_logging(a.verbose)

    # Before anything else: a missing password should not be discovered after
    # resolving twenty taxon keys.
    credentials()

    key = a.key
    if not key:
        if not a.species:
            ap.error("give --species, or --key to resume")
        keys = []
        for name in a.species:
            k, sci, _ = taxon_key(name)
            log.info("%s -> GBIF taxon %s (%s)", name, k, sci)
            keys.append(k)
        key = request_download(keys, a.start, a.end, a.email)
        log.info("requested download %s - it survives this process, so if "
                 "anything interrupts, resume with --key %s", key, key)

    meta = wait_for(key)
    path = fetch_zip(meta, key)
    store(path)
    log.info("Now rebuild and check:")
    log.info("  python3 -m src.migration --from %s --to %s", a.start, a.end)
    log.info("  python3 -m src.validate")
    # GBIF asks that downloads be cited; the DOI is per download.
    if meta.get("doi"):
        log.info("GBIF download DOI: %s", meta["doi"])


if __name__ == "__main__":
    main()
