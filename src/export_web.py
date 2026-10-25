"""Write the map's data files from the database.

The map is a static page with no server behind it, so the whole dataset has to
arrive in one download and then be filtered in the browser. Records are
therefore written as parallel arrays with dictionary-encoded species, sites,
observers and dates - which is around a fifth the size of the equivalent
GeoJSON, and fast to filter without allocating per-record objects.

Also writes sightings.geojson, for opening in QGIS or anything else that reads
GeoJSON.
"""
import json

from .config import DATA, WEB_DATA
from .db import db
from .util import in_uk, iso_now, log

# Bit flags on each record.
F_NOTABLE = 1
F_SITE_PRECISION = 2
F_OBSCURED = 4
F_AGGREGATE = 8

SOURCE_LABELS = {
    "ebird": "eBird",
    "inaturalist": "iNaturalist",
    "birdweather": "BirdWeather",
    "gbif": "GBIF",
    "blog": "County blogs",
    "countyrecorder": "County recorders",
    "bluesky": "Bluesky",
}

# How to turn a stored ref back into a link, client-side.
URL_TEMPLATES = {
    "ebird": "https://ebird.org/checklist/{ref}",
    "inaturalist": "https://www.inaturalist.org/observations/{ref}",
    "birdweather": "https://app.birdweather.com/stations/{ref}",
    "gbif": "https://www.gbif.org/occurrence/{ref}",
    "blog": "{ref}",
    "countyrecorder": "{ref}",
    "bluesky": "{ref}",
}


# How many days each side of the comparison, and the floor a species has to
# clear before a change in its reporting rate means anything.
TREND_WINDOW = 7
TREND_SMOOTHING = 6
# Combined over both weeks. A national movement is not a dozen records. Lower
# than it was because the acoustic rows are now excluded (see TREND_SOURCES),
# which cuts the volume the trend is measured on by more than half.
TREND_MIN_RECORDS = 150

# Only sources that carry a real observation date can say what changed this
# week. BirdWeather is a station total with no date of its own - the exporter
# spreads those across the window by the dated records' own daily profile - so
# feeding them back into a week-on-week trend is circular. Worse, the acoustic
# dump is heavily recency-weighted and biased to vocal garden birds: including
# it put Dunnock, Wren and Jackdaw above every real migrant.
TREND_SOURCES = {"ebird", "inaturalist", "blog", "countyrecorder", "bluesky"}

# "Which birds are moving?" should mean birds that move. Genera that are
# migratory, irruptive or strongly influxed in Britain - so a Fieldfare
# arrival counts and a good week for House Sparrows does not. Judged at genus
# level because that is the grain the rest of the groups use and it survives
# the vernacular differences between sources.
#
# Deliberately absent: tits, corvids, woodpeckers, sparrows, wren, dunnock,
# pigeons, pheasants, owls, nuthatch, treecreeper, kingfisher - the resident
# set, which was filling the list purely on recording effort. Also absent is
# `larus`: the large gulls are a mix of residents and partial migrants and
# including the genus brought in more noise than signal.
#
# Blackbird, Song Thrush, Starling and Goldcrest ARE here on purpose. They
# breed here and are often called residents, but all four get a large autumn
# influx from the continent, which is exactly the kind of movement this is for.
SEASONAL_GENERA = set("""
turdus zoothera catharus geokichla
phylloscopus sylvia curruca acrocephalus locustella helopsaltes hippolais
iduna regulus
oenanthe saxicola phoenicurus luscinia muscicapa ficedula monticola calliope
tarsiger
hirundo delichon riparia apus
charadrius thinornis eudromias pluvialis vanellus calidris tringa actitis
arenaria numenius limosa gallinago lymnocryptes scolopax recurvirostra
himantopus phalaropus
anser branta cygnus anas mareca spatula aythya netta melanitta clangula
mergus mergellus somateria bucephala tadorna
hydrobates oceanodroma oceanites puffinus calonectris ardenna morus fulmarus
stercorarius alle fratercula uria alca cepphus rissa hydrocoloeus xema
pagophila
sterna sternula chlidonias thalasseus gelochelidon hydroprogne ichthyaetus
fringilla acanthis spinus loxia carduelis coccothraustes plectrophenax
calcarius emberiza
anthus motacilla alauda lullula eremophila
cuculus caprimulgus streptopelia merops upupa jynx lanius bombycilla
pandion pernis circus
sturnus
""".split())
# A fall has to be a real fall, not just a smaller slice of a bigger week.
TREND_FALL = 0.8

# A movement has to be *somewhere* as well as numerous. A single mega-rarity
# pulls in a crowd of observers, and a hundred records of one bird standing in
# one bush outscores a genuine national arrival on reporting rate alone.
# Counting distinct quarter-degree cells (about 25 km) separates the two
# cleanly - measured over the last fortnight, the twitches sit at 3 to 11
# cells and real movements at 440 to 1060, so anything in between is a safe
# floor. Forty leaves room for a genuinely regional movement to qualify.
CELL_LAT = 0.25
CELL_LON = 0.5
TREND_MIN_CELLS = 40


def _movers(species_names, sci_names, recent, prior,
            recent_cells, prior_cells, limit=14):
    """Species that are actually on the move, week on week.

    Four things have to be true at once, because each one alone is misleading:

    * **Share, not count.** The database is recency-biased - the last seven
      days hold 2.4x the records of the seven before - so every species gets
      that multiplier for free and the list fills with whichever common birds
      are numerous. Comparing each species' *share* of the week's records
      cancels it out.
    * **Spread.** One mega-rarity pulls in a crowd, and a hundred records of a
      single bird in a single bush outscores a national arrival. Distinct
      quarter-degree cells (~25 km) separate them cleanly: measured over a
      fortnight the twitches sat at 3-11 cells and real movements at 440+.
      Checked in whichever week the bird was present, since a departure has
      few recent records by definition.
    * **Volume.** A national movement is not a dozen records.
    * **A real change in the raw count too.** Once shares are compared, a
      species that merely held steady through a busier week reads as a 2.4x
      *fall*. Little Egret going 453 -> 401 is not a departure. A fall has to
      show up in the raw numbers as well.

    Both directions are returned, scored on the same scale and labelled.
    """
    total_now = sum(recent.values())
    total_was = sum(prior.values())
    out = []
    for sp, name in enumerate(species_names):
        now = recent.get(sp, 0)
        was = prior.get(sp, 0)
        if now + was < TREND_MIN_RECORDS:
            continue
        spread = max(len(recent_cells.get(sp, ())), len(prior_cells.get(sp, ())))
        if spread < TREND_MIN_CELLS:
            continue
        # "Birds" (Aves) and "Perching Birds" (Passeriformes) are real rows in
        # the data but they are not species, and they are not moving anywhere.
        words = (sci_names.get(sp) or "").lower().split()
        if len(words) < 2:
            continue
        if words[0] not in SEASONAL_GENERA:
            continue
        share_now = (now + TREND_SMOOTHING) / (total_now + TREND_SMOOTHING)
        share_was = (was + TREND_SMOOTHING) / (total_was + TREND_SMOOTHING)
        ratio = share_now / share_was
        if ratio >= 1:
            direction, score = "up", ratio
            if now <= was:
                continue
        else:
            direction, score = "down", 1 / ratio
            if now > was * TREND_FALL:
                continue
        # 1.6 was set when the trend still had the acoustic rows behind it.
        # On the dated-only sample the whole distribution is tighter, and that
        # bar was cutting genuine arrivals - Redwing at 98 -> 256 among them.
        if score < 1.5:
            continue
        out.append({"sp": sp, "now": now, "was": was,
                    "direction": direction, "score": round(score, 2)})
    out.sort(key=lambda m: -m["score"])
    return out[:limit]


class _Dict:
    """Interning table: value -> index, preserving insertion order."""

    def __init__(self):
        self.items = []
        self._ix = {}

    def add(self, value):
        if value is None or value == "":
            return -1
        i = self._ix.get(value)
        if i is None:
            i = len(self.items)
            self._ix[value] = i
            self.items.append(value)
        return i


def _ref_for(row):
    """The shortest string that can rebuild this record's link."""
    source, url = row["source"], row["url"] or ""
    extra = {}
    if row["extra"]:
        try:
            extra = json.loads(row["extra"])
        except (ValueError, TypeError):
            extra = {}
    if source == "ebird":
        return url.rsplit("/", 1)[-1] if url else ""
    if source == "inaturalist":
        return row["uid"].split(":", 1)[1]
    if source == "birdweather":
        return str(extra.get("station_id") or "")
    if source == "gbif":
        return row["uid"].split(":", 1)[1]
    return url


def export():
    species_d, site_d, observer_d, date_d, ref_d = (_Dict() for _ in range(5))
    sci_by_species = {}
    photo_by_species = {}
    recent_counts, prior_counts = {}, {}
    recent_cells, prior_cells = {}, {}

    with db() as conn:
        species_meta = {r["common"]: (r["sci"], r["photo"], r["photo_credit"])
                        for r in conn.execute(
                            "SELECT common, sci, photo, photo_credit FROM species "
                            "WHERE common IS NOT NULL")}
    sources = []
    recs = []
    species_totals = {}
    source_counts = {}

    with db() as conn:
        trend_rows = []
        rows = conn.execute(
            "SELECT uid, source, common, sci, species_key, count, obs_date, "
            "obs_time, lat, lon, precision, site, region, observer, url, "
            "notable, extra FROM sighting ORDER BY obs_date DESC")
        for r in rows:
            if not r["common"]:
                continue
            sp = species_d.add(r["common"])
            sci_by_species.setdefault(sp, r["sci"] or "")
            if sp not in photo_by_species:
                meta = species_meta.get(r["common"])
                photo_by_species[sp] = (meta[1], meta[2]) if meta else (None, None)
            if r["source"] not in sources:
                sources.append(r["source"])
            src = sources.index(r["source"])

            flags = 0
            if r["notable"]:
                flags |= F_NOTABLE
            if r["precision"] == "site":
                flags |= F_SITE_PRECISION
            elif r["precision"] == "obscured":
                flags |= F_OBSCURED
            if r["source"] == "birdweather":
                flags |= F_AGGREGATE

            recs.append([
                sp,
                round(r["lat"], 5),
                round(r["lon"], 5),
                date_d.add(r["obs_date"]),
                src,
                r["count"] or 0,
                site_d.add(r["site"]),
                observer_d.add(r["observer"]),
                flags,
                ref_d.add(_ref_for(r)),
                r["obs_time"] or "",
            ])
            species_totals[sp] = species_totals.get(sp, 0) + 1
            source_counts[r["source"]] = source_counts.get(r["source"], 0) + 1
            if r["source"] in TREND_SOURCES:
                trend_rows.append((sp, r["obs_date"], r["lat"], r["lon"]))

    # Dates ascending, with records renumbered onto the sorted order.
    order = sorted(range(len(date_d.items)), key=lambda i: date_d.items[i])
    remap = {old: new for new, old in enumerate(order)}
    dates_sorted = [date_d.items[i] for i in order]
    for rec in recs:
        rec[3] = remap[rec[3]]

    # Week-on-week movers, for the "which birds are moving?" suggestions.
    if dates_sorted:
        from datetime import date as _date, timedelta as _td
        last = _date.fromisoformat(dates_sorted[-1])
        recent_from = (last - _td(days=TREND_WINDOW - 1)).isoformat()
        prior_from = (last - _td(days=TREND_WINDOW * 2 - 1)).isoformat()
        for sp, day, lat, lon in trend_rows:
            # This is a UK map, so "which birds are moving?" has to mean
            # moving *here*. Judged across Europe, the answer came back
            # Greater Flamingo - 417 records, of which 17 were in Britain and
            # every one of those was the captive flock at WWT Slimbridge.
            if not in_uk(lat, lon):
                continue
            cell = (round(lat / CELL_LAT), round(lon / CELL_LON))
            if day >= recent_from:
                recent_counts[sp] = recent_counts.get(sp, 0) + 1
                recent_cells.setdefault(sp, set()).add(cell)
            elif day >= prior_from:
                prior_counts[sp] = prior_counts.get(sp, 0) + 1
                prior_cells.setdefault(sp, set()).add(cell)
    movers = _movers(species_d.items, sci_by_species, recent_counts,
                     prior_counts, recent_cells, prior_cells)

    payload = {
        "generated": iso_now(),
        "trendWindow": TREND_WINDOW,
        "movers": movers,
        "dates": dates_sorted,
        "species": [[name, sci_by_species.get(i, ""), species_totals.get(i, 0),
                     (photo_by_species.get(i) or (None, None))[0] or "",
                     (photo_by_species.get(i) or (None, None))[1] or ""]
                    for i, name in enumerate(species_d.items)],
        "sources": [{"key": s, "label": SOURCE_LABELS.get(s, s),
                     "url": URL_TEMPLATES.get(s, ""),
                     "count": source_counts.get(s, 0)} for s in sources],
        "sites": site_d.items,
        "observers": observer_d.items,
        "refs": ref_d.items,
        "recs": recs,
    }

    WEB_DATA.mkdir(parents=True, exist_ok=True)
    out = WEB_DATA / "sightings.json"
    out.write_text(json.dumps(payload, separators=(",", ":")))
    size_mb = out.stat().st_size / 1e6
    log.info("export: %d records -> %s (%.1f MB)", len(recs), out, size_mb)

    _write_geojson(dates_sorted, species_d, site_d, observer_d, sources, recs)
    return out


def _write_geojson(dates, species_d, site_d, observer_d, sources, recs):
    """Full dataset as GeoJSON, for GIS use."""
    path = DATA / "sightings.geojson"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write('{"type":"FeatureCollection","features":[\n')
        for n, rec in enumerate(recs):
            sp, lat, lon, d, src, cnt, site, obs, flags, _ref, tm = rec
            props = {
                "species": species_d.items[sp],
                "date": dates[d],
                "time": tm or None,
                "source": sources[src],
                "count": cnt or None,
                "site": site_d.items[site] if site >= 0 else None,
                "observer": observer_d.items[obs] if obs >= 0 else None,
                "notable": bool(flags & F_NOTABLE),
                "precision": ("obscured" if flags & F_OBSCURED else
                              "site" if flags & F_SITE_PRECISION else "exact"),
            }
            feature = {"type": "Feature",
                       "geometry": {"type": "Point", "coordinates": [lon, lat]},
                       "properties": props}
            fh.write(("," if n else "") + json.dumps(feature, separators=(",", ":")) + "\n")
        fh.write("]}\n")
    log.info("export: GeoJSON -> %s (%.1f MB)", path, path.stat().st_size / 1e6)


if __name__ == "__main__":
    from .util import setup_logging
    setup_logging()
    export()
