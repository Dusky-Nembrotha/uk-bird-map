"""eBird adapter.

Three passes, in increasing cost:

1. `notable`  - per country. Returns full-detail records (counts, observer,
   checklist) for anything flagged rare/unusual. Cheap and high value.
2. `recent`   - per county (109 of them). One record per species per county,
   so it is the cheapest way to blanket the whole country.
3. `historic` - per county per day, threaded and opt-in (`--deep`). Full
   detail including counts and observers, one record per species per day,
   which is where most of the volume lives.

eBird's own endpoints already deduplicate within a call; `obsId`/`subId` keep
rows stable across runs so repeat fetches upsert rather than duplicate.
"""
import concurrent.futures as cf
from datetime import timedelta

from ..config import CFG
from ..species import load as load_species
from ..util import RateLimiter, in_area, iso_now, log, parse_date, request_json, since_date

API = "https://api.ebird.org/v2"
COUNTRIES = ("GB-ENG", "GB-SCT", "GB-WLS", "GB-NIR")

# Europe at country level. The UK keeps its county-by-county sweep; elsewhere
# one call per country is the sensible trade between coverage and politeness.
EUROPE_COUNTRIES = (
    "IE", "FR", "ES", "PT", "AD", "BE", "NL", "LU", "DE", "DK", "NO", "SE",
    "FI", "IS", "FO", "EE", "LV", "LT", "PL", "CZ", "SK", "AT", "CH", "LI",
    "IT", "MT", "SM", "VA", "SI", "HR", "BA", "RS", "ME", "MK", "AL", "GR",
    "BG", "RO", "MD", "UA", "BY", "HU", "CY", "TR", "GI", "MC", "JE", "GG",
    "IM",
)

_limiter = RateLimiter(0.25)


def _headers():
    return {"X-eBirdApiToken": CFG["ebird_api_token"]}


def _get(path, **params):
    return request_json("GET", f"{API}/{path}", headers=_headers(),
                        limiter=_limiter, params=params, timeout=120)


def counties():
    """All subnational2 regions (UK counties / unitary authorities)."""
    out = []
    for c in COUNTRIES:
        try:
            for r in _get(f"ref/region/list/subnational2/{c}"):
                out.append((r["code"], r["name"]))
        except Exception as e:  # noqa: BLE001
            log.warning("ebird: county list failed for %s (%s)", c, e)
    return out


def _row(rec, idx, notable=False):
    lat, lon = rec.get("lat"), rec.get("lng")
    if not in_area(lat, lon):
        return None
    common, sci, key = idx.canonical(rec.get("comName"), rec.get("sciName"))
    if not key:
        return None
    obs_dt = rec.get("obsDt") or ""
    obs_date = parse_date(obs_dt)
    if not obs_date:
        return None
    sub = rec.get("subId")
    uid = rec.get("obsId") or (f"{sub}-{rec.get('speciesCode')}" if sub else
                               f"{rec.get('locId')}-{rec.get('speciesCode')}-{obs_dt}")
    observer = rec.get("userDisplayName")
    if not observer and (rec.get("firstName") or rec.get("lastName")):
        observer = " ".join(x for x in (rec.get("firstName"),
                                        rec.get("lastName")) if x)
    return {
        "uid": f"ebird:{uid}",
        "source": "ebird",
        "common": common,
        "sci": sci,
        "species_key": key,
        "count": rec.get("howMany"),
        "obs_date": obs_date,
        "obs_time": obs_dt[11:16] or None,
        "lat": float(lat),
        "lon": float(lon),
        "precision": "site" if rec.get("locationPrivate") else "exact",
        "site": rec.get("locName"),
        "region": rec.get("subnational2Name") or rec.get("subnational1Name"),
        "observer": observer,
        "url": f"https://ebird.org/checklist/{sub}" if sub else None,
        "confidence": None,
        "notable": 1 if notable else 0,
        "extra": {"speciesCode": rec.get("speciesCode"),
                  "locId": rec.get("locId"),
                  "reviewed": rec.get("obsReviewed")},
        "fetched_at": iso_now(),
    }


def fetch(deep=False, days_back=None, workers=5):
    """Yield sighting dicts from eBird."""
    if not CFG["ebird_api_token"]:
        log.warning("ebird: no API token configured - skipping. "
                    "Get a free key at https://ebird.org/api/keygen")
        return []

    idx = load_species()
    days = CFG["days_back"] if days_back is None else days_back
    rows = {}

    def add(recs, notable=False):
        kept = 0
        for rec in recs or []:
            r = _row(rec, idx, notable=notable)
            if r:
                # A record already seen as notable keeps that flag.
                prev = rows.get(r["uid"])
                if prev and prev["notable"]:
                    r["notable"] = 1
                rows[r["uid"]] = r
                kept += 1
        return kept

    # 1. Notable (rare / unusual) records, full detail.
    for c in COUNTRIES:
        try:
            recs = _get(f"data/obs/{c}/recent/notable", back=min(days, 30),
                        detail="full", maxResults=10000)
            log.info("ebird: %s notable -> %d kept", c, add(recs, notable=True))
        except Exception as e:  # noqa: BLE001
            log.warning("ebird: notable failed for %s (%s)", c, e)

    # 2a. Europe, one call per country.
    if CFG.get("region") == "europe":
        for code in EUROPE_COUNTRIES:
            try:
                recs = _get(f"data/obs/{code}/recent", back=min(days, 30),
                            includeProvisional="true", cat="species",
                            maxResults=10000)
                add(recs)
            except Exception as e:  # noqa: BLE001
                log.debug("ebird: country %s failed: %s", code, e)
            try:
                recs = _get(f"data/obs/{code}/recent/notable",
                            back=min(days, 30), detail="full", maxResults=10000)
                add(recs, notable=True)
            except Exception as e:  # noqa: BLE001
                log.debug("ebird: notable %s failed: %s", code, e)
        log.info("ebird: %d records after the European sweep", len(rows))

    # 2b. Broad sweep: most recent record per species per UK county.
    cs = counties()
    log.info("ebird: sweeping %d counties", len(cs))
    for code, name in cs:
        try:
            recs = _get(f"data/obs/{code}/recent", back=min(days, 30),
                        includeProvisional="true", cat="species",
                        maxResults=10000)
            add(recs)
        except Exception as e:  # noqa: BLE001
            log.warning("ebird: county %s (%s) failed: %s", name, code, e)
    log.info("ebird: %d records after county sweep", len(rows))

    # 3. Deep pass: per county per day. Threaded - this is the slow one.
    if deep:
        start = since_date(days)
        dates = [start + timedelta(days=i) for i in range(days + 1)]
        jobs = [(code, name, d) for code, name in cs for d in dates]
        log.info("ebird: deep pass over %d county-days with %d workers",
                 len(jobs), workers)

        def one(job):
            code, name, d = job
            try:
                return _get(f"data/obs/{code}/historic/{d.year}/{d.month}/{d.day}",
                            detail="full", rank="mrec", cat="species",
                            includeProvisional="true", maxResults=10000)
            except Exception as e:  # noqa: BLE001
                log.debug("ebird: historic %s %s failed: %s", code, d, e)
                return []

        done = 0
        with cf.ThreadPoolExecutor(max_workers=workers) as pool:
            for recs in pool.map(one, jobs):
                add(recs)
                done += 1
                if done % 200 == 0:
                    log.info("ebird: deep %d/%d county-days, %d records",
                             done, len(jobs), len(rows))

    log.info("ebird: %d records total", len(rows))
    return list(rows.values())
