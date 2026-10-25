"""BirdWeather adapter (public GraphQL API, no key required).

BirdWeather is a network of BirdNET-Pi acoustic recorders. Raw detections run
to hundreds of thousands a day in the UK alone, which is far too many to plot
and mostly repeat detections of the same bird at the same box. So instead of
raw detections this fetches, per station, the species detected over several
nested time windows (1/3/7/14 days) in a single query. The shortest window a
species appears in dates the record, which costs no extra requests.

Records are therefore station-level aggregates, not individual observations:
each carries the number of detections in `count`, `precision='site'`, and
`extra.aggregate` so the map can label them honestly. Detections are machine
identifications from sound, so they are noisier than a birder's record - the
`min_confidence` setting and BirdWeather's own `avian` classification filter
out the worst of it (sirens, engines, squirrels).
"""
from datetime import date, timedelta

from ..config import AREA_BBOX, CFG, UK_BBOX
from ..species import load as load_species
from ..util import RateLimiter, in_area, iso_now, log, parse_date, request_json

GRAPHQL = "https://app.birdweather.com/graphql"
STATIONS_PER_PAGE = 20
BUCKETS = (1, 3, 7, 14)      # days; shortest window a species appears in wins

_limiter = RateLimiter(0.4)

# The aggregate endpoint carries no confidence information at all - its
# averageProbability is always null and topSpecies takes no confidence
# argument - so filtering by certainty means going to the raw detections feed
# and aggregating here. That is far more requests, hence opt-in.
_DETECTIONS_QUERY = """
query UKDetections($ne: InputLocation!, $sw: InputLocation!,
                   $period: InputDuration!, $minConf: Float!, $after: String) {
  detections(ne: $ne, sw: $sw, period: $period, confidenceGte: $minConf,
             first: 1000, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes {
      timestamp
      confidence
      coords { lat lon }
      species { commonName scientificName ebirdCode classification }
      station { id name type country state locationPrivacy locationPrivacyRadius }
    }
  }
}
"""

_QUERY = """
query UKStations($ne: InputLocation!, $sw: InputLocation!, $limit: Int!,
                 $p1: InputDuration!, $p3: InputDuration!,
                 $p7: InputDuration!, $p14: InputDuration!, $after: String) {
  stations(ne: $ne, sw: $sw, period: $p14, first: %d, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      type
      country
      state
      coords { lat lon }
      locationPrivacy
      locationPrivacyRadius
      latestDetectionAt
      b1: topSpecies(period: $p1, limit: $limit) { ...SC }
      b3: topSpecies(period: $p3, limit: $limit) { ...SC }
      b7: topSpecies(period: $p7, limit: $limit) { ...SC }
      b14: topSpecies(period: $p14, limit: $limit) { ...SC }
    }
  }
}
fragment SC on SpeciesCount {
  count
  averageProbability
  species { commonName scientificName ebirdCode classification }
}
""" % STATIONS_PER_PAGE


def _period(days):
    return {"count": days, "unit": "day"}


def fetch(days_back=None):
    cfg = CFG["birdweather"]
    if cfg.get("high_confidence"):
        if CFG.get("region") == "europe":
            # ~900k detections a day across Europe: reading them all to filter
            # on confidence would take hours, so the station aggregate is used
            # instead and the confidence threshold does not apply.
            log.info("birdweather: region is europe, using the station "
                     "aggregate - the confidence filter is UK-scale only")
        else:
            return fetch_confident(days_back)
    return fetch_aggregate(days_back)


def fetch_confident(days_back=None):
    """Every detection at or above `min_confidence`, folded down to one row
    per station per species. Exact, but it reads the raw feed: expect a
    thousand-odd requests for a week of UK data."""
    idx = load_species()
    cfg = CFG["birdweather"]
    days = CFG["days_back"] if days_back is None else days_back
    min_conf = float(cfg.get("min_confidence") or 0.8)
    max_pages = int(cfg.get("max_pages") or 2000)
    today = date.today()

    variables = {
        "ne": {"lat": AREA_BBOX["north"], "lon": AREA_BBOX["east"]},
        "sw": {"lat": AREA_BBOX["south"], "lon": AREA_BBOX["west"]},
        "period": _period(days),
        "minConf": min_conf,
        "after": None,
    }

    rows = {}
    pages = 0
    after = None
    while pages < max_pages:
        variables["after"] = after
        try:
            data = request_json("POST", GRAPHQL,
                                json={"query": _DETECTIONS_QUERY,
                                      "variables": variables},
                                limiter=_limiter, timeout=180)
        except Exception as e:  # noqa: BLE001
            log.warning("birdweather: detections page failed (%s) - stopping", e)
            break
        if data.get("errors"):
            log.warning("birdweather: %s", data["errors"][:1])
            break

        conn = (data.get("data") or {}).get("detections") or {}
        nodes = conn.get("nodes") or []
        if pages == 0:
            log.info("birdweather: %s detections at >= %.0f%% confidence "
                     "in the last %d days",
                     f"{conn.get('totalCount', 0):,}", min_conf * 100, days)
        for det in nodes:
            _fold_detection(det, idx, rows, today)

        page = conn.get("pageInfo") or {}
        after = page.get("endCursor")
        pages += 1
        if pages % 50 == 0:
            log.info("birdweather: %d pages, %d station-species rows",
                     pages, len(rows))
        if not page.get("hasNextPage") or not after:
            break
    else:
        log.warning("birdweather: stopped at the %d page cap - the result is "
                    "a partial sweep", max_pages)

    log.info("birdweather: %d records from %d pages (>= %.0f%% confidence)",
             len(rows), pages, min_conf * 100)
    return list(rows.values())


def _fold_detection(det, idx, rows, today):
    """One row per station per species, keeping the best and latest."""
    st = det.get("station") or {}
    coords = det.get("coords") or {}
    lat, lon = coords.get("lat"), coords.get("lon")
    if not in_area(lat, lon):
        return
    if CFG.get("region") != "europe":
        country = (st.get("country") or "").strip().lower()
        if country and country not in UK_COUNTRIES:
            return
    sp = det.get("species") or {}
    if (sp.get("classification") or "").lower() != "avian":
        return
    common, sci, key = idx.canonical(sp.get("commonName"), sp.get("scientificName"))
    if not key:
        return

    ts = det.get("timestamp") or ""
    day = parse_date(ts) or today.isoformat()
    uid = f"bw:{st.get('id')}:{key}"
    name = st.get("name") or f"Station {st.get('id')}"
    radius = st.get("locationPrivacyRadius") or 0
    private = bool(st.get("locationPrivacy")) or radius > 1000
    conf = det.get("confidence")

    row = rows.get(uid)
    if row is None:
        rows[uid] = {
            "uid": uid, "source": "birdweather", "common": common, "sci": sci,
            "species_key": key, "count": 1, "obs_date": day,
            "obs_time": ts[11:16] or None,
            "lat": float(lat), "lon": float(lon),
            "precision": "site" if private else "exact",
            "site": name, "region": st.get("state"), "observer": name,
            "url": f"https://app.birdweather.com/stations/{st.get('id')}",
            "confidence": conf, "notable": 0,
            "extra": {"aggregate": True, "detections": 1,
                      "station_id": st.get("id"), "station_type": st.get("type"),
                      "privacy_radius_m": radius or None,
                      "min_confidence": True,
                      "ebird_code": sp.get("ebirdCode")},
            "fetched_at": iso_now(),
        }
        return
    row["count"] += 1
    row["extra"]["detections"] = row["count"]
    if conf is not None and (row["confidence"] is None or conf > row["confidence"]):
        row["confidence"] = conf
    if day > row["obs_date"]:
        row["obs_date"] = day
        row["obs_time"] = ts[11:16] or None


def fetch_aggregate(days_back=None):
    idx = load_species()
    days = CFG["days_back"] if days_back is None else days_back
    cfg = CFG["birdweather"]
    limit = cfg["max_species_per_station"]
    buckets = [b for b in BUCKETS if b < days] + [days]

    variables = {
        "ne": {"lat": AREA_BBOX["north"], "lon": AREA_BBOX["east"]},
        "sw": {"lat": AREA_BBOX["south"], "lon": AREA_BBOX["west"]},
        "limit": limit,
        "p1": _period(buckets[0]),
        "p3": _period(buckets[1] if len(buckets) > 1 else buckets[0]),
        "p7": _period(buckets[2] if len(buckets) > 2 else buckets[-1]),
        "p14": _period(buckets[-1]),
        "after": None,
    }
    bucket_days = [variables["p1"]["count"], variables["p3"]["count"],
                   variables["p7"]["count"], variables["p14"]["count"]]

    rows = {}
    stations = 0
    after = None
    today = date.today()

    while True:
        variables["after"] = after
        try:
            data = request_json("POST", GRAPHQL, json={"query": _QUERY,
                                                       "variables": variables},
                                limiter=_limiter, timeout=180)
        except Exception as e:  # noqa: BLE001
            log.warning("birdweather: page failed (%s) - stopping", e)
            break
        if data.get("errors"):
            log.warning("birdweather: %s", data["errors"][:1])
            break

        conn = (data.get("data") or {}).get("stations") or {}
        nodes = conn.get("nodes") or []
        if stations == 0:
            log.info("birdweather: %d UK stations active in last %d days",
                     conn.get("totalCount", 0), days)
        for st in nodes:
            stations += 1
            rows.update(_station_rows(st, idx, bucket_days, today, cfg))

        page = conn.get("pageInfo") or {}
        after = page.get("endCursor")
        if not page.get("hasNextPage") or not after:
            break
        if stations % 100 < STATIONS_PER_PAGE:
            log.info("birdweather: %d stations, %d records", stations, len(rows))

    log.info("birdweather: %d records from %d stations", len(rows), stations)
    return list(rows.values())


UK_COUNTRIES = {"united kingdom", "uk", "gb", "great britain",
                "england", "scotland", "wales", "northern ireland"}


def _station_rows(st, idx, bucket_days, today, cfg):
    coords = st.get("coords") or {}
    lat, lon = coords.get("lat"), coords.get("lon")
    if not in_area(lat, lon):
        return {}
    # The query bounding box also covers Ireland, the Channel Islands and part
    # of France, so the station's own country is what decides.
    if CFG.get("region") != "europe":
        country = (st.get("country") or "").strip().lower()
        if country and country not in UK_COUNTRIES:
            return {}

    # Stations can hide their exact position; respect the declared radius.
    radius = st.get("locationPrivacyRadius") or 0
    private = bool(st.get("locationPrivacy")) or radius > 1000
    name = st.get("name") or f"Station {st.get('id')}"

    # Walk the windows shortest-first so each species gets its most recent
    # plausible date, and so the narrowest window's count is not overwritten.
    out = {}
    for field, window in zip(("b1", "b3", "b7", "b14"), bucket_days):
        for sc in st.get(field) or []:
            sp = sc.get("species") or {}
            if (sp.get("classification") or "").lower() != "avian":
                continue
            prob = sc.get("averageProbability")
            if prob is not None and prob < cfg["min_confidence"]:
                continue
            common, sci, key = idx.canonical(sp.get("commonName"),
                                             sp.get("scientificName"))
            if not key:
                continue
            uid = f"bw:{st.get('id')}:{key}"
            if uid in out:
                continue          # already dated by a shorter window
            out[uid] = {
                "uid": uid,
                "source": "birdweather",
                "common": common,
                "sci": sci,
                "species_key": key,
                "count": sc.get("count"),
                "obs_date": (today - timedelta(days=max(window - 1, 0))).isoformat(),
                "obs_time": None,
                "lat": float(lat),
                "lon": float(lon),
                "precision": "site" if private else "exact",
                "site": name,
                "region": st.get("state"),
                "observer": name,
                "url": f"https://app.birdweather.com/stations/{st.get('id')}",
                "confidence": prob,
                "notable": 0,
                "extra": {"aggregate": True,
                          "window_days": window,
                          "detections": sc.get("count"),
                          "station_id": st.get("id"),
                          "station_type": st.get("type"),
                          "privacy_radius_m": radius or None,
                          "ebird_code": sp.get("ebirdCode")},
                "fetched_at": iso_now(),
            }
    return out
