"""GBIF adapter.

GBIF aggregates datasets that no other source here exposes directly (ringing
schemes, museum and survey data, some BTO feeds), but publication lags by
weeks to years, so it contributes fewer genuinely recent records than eBird or
iNaturalist. Records that GBIF itself flags as originating from eBird or
iNaturalist are dropped, since those arrive fresher via their own adapters.
"""
from datetime import date, timedelta

from ..config import AREA_BBOX, CFG
from ..species import load as load_species
from ..util import RateLimiter, in_area, iso_now, log, parse_date, request_json, since_date

API = "https://api.gbif.org/v1/occurrence/search"
AVES_TAXON_KEY = 212
PAGE = 300
GBIF_MAX_OFFSET = 100_000

# Publishers whose records we already fetch live from their own APIs, matched
# on name and on GBIF's dataset keys (names are not always populated).
_SKIP_PUBLISHERS = {"ebird", "inaturalist", "birdweather"}
_SKIP_DATASET_KEYS = {
    "50c9509d-22c7-4a22-a47d-8c48425ef4a7",   # iNaturalist research-grade
    "4fa7b334-ce0d-4e88-aaae-2e0c138d049e",   # eBird observation dataset
}

_limiter = RateLimiter(0.4)


def _area_filter():
    """Restrict to the configured region. GBIF takes a WKT polygon, which is
    how Europe is expressed without listing fifty country codes."""
    if CFG.get("region") != "europe":
        return {"country": "GB"}
    b = AREA_BBOX
    poly = (f"POLYGON(({b['west']} {b['south']},{b['east']} {b['south']},"
            f"{b['east']} {b['north']},{b['west']} {b['north']},"
            f"{b['west']} {b['south']}))")
    return {"geometry": poly}


def _is_duplicate_source(rec):
    if (rec.get("datasetKey") or "").lower() in _SKIP_DATASET_KEYS:
        return True
    blob = " ".join(str(rec.get(k) or "") for k in
                    ("datasetName", "institutionCode", "collectionCode",
                     "publishingOrgKey", "datasetKey")).lower()
    return any(p in blob for p in _SKIP_PUBLISHERS)


def _row(rec, idx):
    lat, lon = rec.get("decimalLatitude"), rec.get("decimalLongitude")
    if not in_area(lat, lon):
        return None
    common, sci, key = idx.canonical(rec.get("vernacularName"),
                                     rec.get("species") or rec.get("scientificName"))
    if not key:
        return None
    obs_date = parse_date(rec.get("eventDate"))
    if not obs_date:
        return None

    unc = rec.get("coordinateUncertaintyInMeters")
    precision = "site" if (unc and unc > 1000) else "exact"
    count = rec.get("individualCount")
    gid = rec.get("key")

    return {
        "uid": f"gbif:{gid}",
        "source": "gbif",
        "common": common,
        "sci": sci,
        "species_key": key,
        "count": count if isinstance(count, int) else None,
        "obs_date": obs_date,
        "obs_time": None,
        "lat": float(lat),
        "lon": float(lon),
        "precision": precision,
        "site": rec.get("locality") or rec.get("verbatimLocality"),
        "region": rec.get("stateProvince"),
        "observer": rec.get("recordedBy"),
        "url": f"https://www.gbif.org/occurrence/{gid}",
        "confidence": None,
        "notable": 0,
        "extra": {"dataset": rec.get("datasetName"),
                  "basisOfRecord": rec.get("basisOfRecord"),
                  "uncertainty_m": unc},
        "fetched_at": iso_now(),
    }


def _page_day(day, idx, rows, max_records, budget):
    """All of one day's occurrences. Slicing by day keeps GBIF's offset small,
    which matters: deep offsets on this API get slower the further in you go,
    and a month of UK bird records is well past the point where it crawls."""
    offset = 0
    skipped = 0
    nxt = (day + timedelta(days=1)).isoformat()
    while offset < min(max_records, GBIF_MAX_OFFSET) and budget["pages"] > 0:
        params = {
            "taxonKey": AVES_TAXON_KEY,
            "hasCoordinate": "true",
            "hasGeospatialIssue": "false",
            "eventDate": f"{day.isoformat()},{nxt}",
            "limit": PAGE,
            "offset": offset,
            **_area_filter(),
        }
        try:
            data = request_json("GET", API, params=params, limiter=_limiter,
                                timeout=120)
        except Exception as e:  # noqa: BLE001
            log.warning("gbif: %s offset %d failed (%s)", day, offset, e)
            break
        budget["pages"] -= 1
        results = data.get("results", [])
        for rec in results:
            if _is_duplicate_source(rec):
                skipped += 1
                continue
            r = _row(rec, idx)
            if r:
                rows[r["uid"]] = r
        offset += PAGE
        if data.get("endOfRecords") or len(results) < PAGE:
            break
    return skipped


def fetch(days_back=None):
    """GBIF publishes in bulk drops a fortnight or more behind, so it gets its
    own, longer window - with the project's usual 14 days it returns nothing at
    all, and the datasets it uniquely carries (Birda, ringing schemes) would be
    missed entirely."""
    idx = load_species()
    if days_back is None:
        days_back = CFG["gbif"].get("days_back") or CFG["days_back"]
    start = since_date(days_back)
    today = date.today()
    max_records = CFG["gbif"]["max_records"]

    total = request_json("GET", API, limiter=_limiter, timeout=120, params={
        "taxonKey": AVES_TAXON_KEY, "hasCoordinate": "true",
        "eventDate": f"{start.isoformat()},{today.isoformat()}", "limit": 0,
        **_area_filter(),
    }).get("count", 0)
    log.info("gbif: %d bird occurrences in %s since %s",
             total, CFG.get("region", "uk"), start)

    rows = {}
    skipped = 0
    # A hard request budget as well as a record cap. Most of what GBIF holds
    # for Europe duplicates iNaturalist and eBird, so the record count climbs
    # slowly while the request count does not - without this the fetch spends
    # hours on deep offsets for records it then discards.
    budget = {"pages": int(CFG["gbif"].get("max_pages") or 400)}
    # Newest day first. The record cap exists because Europe holds half a
    # million occurrences in a month; walking forwards would spend the whole
    # budget on the oldest days and return nothing from this week.
    day = today
    while day >= start:
        skipped += _page_day(day, idx, rows, max_records, budget)
        if (today - day).days % 5 == 4:
            log.info("gbif: back to %s, %d records", day, len(rows))
        day -= timedelta(days=1)
        if budget["pages"] <= 0:
            log.info("gbif: spent the request budget at %s", day)
            break
        if len(rows) >= max_records:
            log.info("gbif: hit the %d record cap at %s - older days skipped",
                     max_records, day)
            break

    log.info("gbif: %d records total (%d skipped as already-covered sources)",
             len(rows), skipped)
    return list(rows.values())
