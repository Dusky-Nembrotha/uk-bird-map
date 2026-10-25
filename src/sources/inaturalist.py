"""iNaturalist adapter.

Paginates with an `id_below` cursor rather than `page`, because iNaturalist
refuses page*per_page beyond 10,000 and UK bird records exceed that over a
fortnight. Observations whose coordinates iNaturalist obscures (threatened or
sensitive species) are kept but marked, so the map can show them honestly as
approximate rather than pretending to a precise grid reference.
"""
from ..config import AREA_BBOX, CFG
from ..species import load as load_species
from ..util import RateLimiter, in_area, iso_now, log, parse_date, request_json, since_date

API = "https://api.inaturalist.org/v1/observations"
UK_PLACE_ID = 6857       # United Kingdom
AVES_TAXON_ID = 3
PER_PAGE = 200

_limiter = RateLimiter(1.1)   # iNaturalist asks for <= 60 requests/minute


def _row(o, idx):
    loc = o.get("location")
    if not loc or "," not in str(loc):
        return None
    try:
        lat, lon = [float(x) for x in str(loc).split(",")[:2]]
    except ValueError:
        return None
    if not in_area(lat, lon):
        return None

    taxon = o.get("taxon") or {}
    common, sci, key = idx.canonical(taxon.get("preferred_common_name"),
                                     taxon.get("name"))
    if not key:
        return None

    obs_date = parse_date((o.get("observed_on_details") or {}).get("date")
                          or o.get("observed_on") or o.get("time_observed_at"))
    if not obs_date:
        return None

    obscured = bool(o.get("obscured") or o.get("coordinates_obscured"))
    acc = o.get("positional_accuracy")
    if obscured:
        precision = "obscured"
    elif acc and acc > 1000:
        precision = "site"
    else:
        precision = "exact"

    return {
        "uid": f"inat:{o['id']}",
        "source": "inaturalist",
        "common": common,
        "sci": sci,
        "species_key": key,
        "count": None,
        "obs_date": obs_date,
        "obs_time": (o.get("time_observed_at") or "")[11:16] or None,
        "lat": lat,
        "lon": lon,
        "precision": precision,
        "site": o.get("place_guess"),
        "region": None,
        "observer": (o.get("user") or {}).get("login"),
        "url": o.get("uri") or f"https://www.inaturalist.org/observations/{o['id']}",
        "confidence": 1.0 if o.get("quality_grade") == "research" else None,
        "notable": 0,
        "extra": {"quality_grade": o.get("quality_grade"),
                  "positional_accuracy": acc,
                  "obscured": obscured,
                  "rank": taxon.get("rank")},
        "fetched_at": iso_now(),
    }


def fetch(days_back=None):
    idx = load_species()
    d1 = since_date(days_back).isoformat()
    cfg = CFG["inaturalist"]
    rows = {}
    id_below = None
    pages = 0

    while pages < cfg["max_pages"]:
        params = {
            "taxon_id": AVES_TAXON_ID,
            "d1": d1,
            "geo": "true",
            "per_page": PER_PAGE,
            "order_by": "id",
            "order": "desc",
            "quality_grade": cfg["quality_grade"],
        }
        if CFG.get("region") == "europe":
            params.update({"swlat": AREA_BBOX["south"], "swlng": AREA_BBOX["west"],
                           "nelat": AREA_BBOX["north"], "nelng": AREA_BBOX["east"]})
        else:
            params["place_id"] = UK_PLACE_ID
        if id_below:
            params["id_below"] = id_below
        try:
            data = request_json("GET", API, params=params, limiter=_limiter)
        except Exception as e:  # noqa: BLE001
            log.warning("inaturalist: page failed (%s) - stopping", e)
            break

        results = data.get("results", [])
        if not results:
            break
        for o in results:
            r = _row(o, idx)
            if r:
                rows[r["uid"]] = r
        id_below = results[-1]["id"]
        pages += 1
        if pages == 1:
            log.info("inaturalist: %d UK bird observations available since %s",
                     data.get("total_results", 0), d1)
        if len(results) < PER_PAGE:
            break
        if pages % 10 == 0:
            log.info("inaturalist: %d pages, %d records", pages, len(rows))

    log.info("inaturalist: %d records total", len(rows))
    return list(rows.values())
