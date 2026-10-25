"""Site-name gazetteer, used to put county-blog reports on the map.

Blogs name places, not coordinates ("New Passage/Pilning Wetlands", "Farmoor
Reservoir"). eBird's hotspot register is the right lookup table for this: it is
a national list of the exact places birders go, with coordinates, and the names
birders actually use. Locations already collected in the sighting table are
added too, which picks up non-hotspot sites.

Matching is deliberately conservative and always constrained to the blog's own
county, because "Severn Beach" and "Warren Point" exist in several counties and
a confident wrong answer is worse than no pin.
"""
import csv
import difflib
import math
import io
import re
import zipfile

from .config import DATA, CFG
from .db import db
from .species import norm
from .util import RateLimiter, in_uk, iso_now, log, request_json, request_text, session

EBIRD_HOTSPOT = "https://api.ebird.org/v2/ref/hotspot/{region}"
GEONAMES_URL = "https://download.geonames.org/export/dump/GB.zip"
GEONAMES_DIR = DATA / "gazetteer_src"
NOMINATIM = "https://nominatim.openstreetmap.org/search"

# GeoNames feature classes worth keeping: populated places, terrain, water,
# parks/areas, and spots (which includes reserves, stations and landmarks).
_GEONAMES_CLASSES = {"P", "T", "H", "L", "S"}

_limiter = RateLimiter(0.25)
_nominatim_limiter = RateLimiter(1.1)   # OSM policy: max 1 request/second

# Generic words that must never match a site on their own.
def bird_name_words():
    """Every word, and every whole name, that is part of a bird's name.

    Used to stop the free-text place finder reading a species as a site. Built
    from the project's own species index so it stays in step with it, and
    cached because it is the same answer every time.
    """
    global _BIRD_WORDS
    if _BIRD_WORDS is not None:
        return _BIRD_WORDS
    words = set()
    try:
        from .species import load as load_species
        idx = load_species()
        for rec in idx.by_key.values():
            names = [rec.get("common") or ""] + list(rec.get("aliases") or [])
            for name in names:
                whole = norm(name)
                if len(whole) >= 4:
                    words.add(whole)
                for w in whole.split():
                    if len(w) >= 4:
                        words.add(w)
                        words.add(w + "s")      # "Cranes", "Cuckoos"
    except Exception:                            # index unavailable: no filter
        pass
    _BIRD_WORDS = words
    return words


_BIRD_WORDS = None

# GeoNames classes that are never where a bird gets reported, but whose names
# collide constantly with ordinary words: 14,613 hotels and 2,616 hospitals,
# and for 14,630 name keys one of them is the ONLY candidate. "This male
# Kestrel posed nicely for me in Norfolk" resolved to the Norfolk & Norwich
# University Hospital. They stay in the index for explicit site lookups, where
# a recorder naming a hotel means it; they are out of free-text matching.
_PROSE_EXCLUDED_KINDS = {"geonames:HTL", "geonames:HSP"}

# Names that point at a whole county, a country or nothing in particular. They
# reach the index because eBird hotspot names carry a ", Suffolk, England, GB"
# tail and `name_variants` splits on commas, so 123 entries end up keyed
# `england` and 58 `scotland`. A line mentioning "Suffolk" then pinned 23
# Landguard ringing records to a hall 42 km away.
_TOO_BROAD = {
    # countries and the eBird name tail
    "england", "scotland", "wales", "ireland", "northern ireland", "uk", "gb",
    "great britain", "britain",
    # counties and regions
    "bedfordshire", "berkshire", "bristol", "buckinghamshire", "cambridgeshire",
    "cheshire", "cleveland", "cornwall", "cumbria", "derbyshire", "devon",
    "dorset", "durham", "essex", "gloucestershire", "hampshire",
    "herefordshire", "hertfordshire", "kent", "lancashire", "leicestershire",
    "lincolnshire", "london", "merseyside", "middlesex", "norfolk",
    "northamptonshire", "northumberland", "nottinghamshire", "oxfordshire",
    "rutland", "shropshire", "somerset", "staffordshire", "suffolk", "surrey",
    "sussex", "warwickshire", "wiltshire", "worcestershire", "yorkshire",
    "angus", "argyll", "ayrshire", "banffshire", "fife", "lothian", "moray",
    "orkney", "shetland", "anglesey", "ceredigion", "clwyd", "dyfed",
    "glamorgan", "gwent", "gwynedd", "powys", "pembrokeshire", "antrim",
    "armagh", "down", "fermanagh", "londonderry", "tyrone",
    "west sussex", "east sussex", "west midlands", "north yorkshire",
    "south yorkshire", "west yorkshire", "east yorkshire", "greater london",
    "greater manchester", "northamptonshire", "west lothian",
    # words that describe no particular place
    "fields", "field", "parking", "heliport", "mainland", "present",
    "reservoirs", "village centre", "city centre", "south shore",
    "north shore", "the wash", "lough neagh", "deer park", "park farm",
    "this n that", "present", "viewed", "seen", "area", "site", "the area",
}

_STOPWORDS = {
    "the", "reserve", "nr", "lnr", "nnr", "rspb", "wwt", "park", "lake",
    "wood", "woods", "farm", "hill", "common", "marsh", "moor", "point",
    "bay", "beach", "valley", "bridge", "garden", "gardens", "lane", "road",
    "river", "brook", "pool", "pools", "ponds", "pond", "reservoir", "sea",
    "north", "south", "east", "west", "upper", "lower", "old", "new", "site",
    "village", "town", "city", "bill", "head", "island", "estuary", "harbour",
    "quay", "docks", "wetlands", "meadow", "meadows", "heath", "hide", "area",
}

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\u2019\-]*")
_SPLIT_RE = re.compile(
    r"\s*(?:/|,|\||–|—| - | and | & | at | nr | near | on )\s*")
_BRACKET_RE = re.compile(r"\s*[\(\[].*?[\)\]]\s*")


def _clean_name(name):
    n = _BRACKET_RE.sub(" ", str(name or ""))
    return re.sub(r"\s+", " ", n).strip()


_COUNTRY_SUFFIX = re.compile(
    r"(?i),\s*(GB|UK|GB-England|England|Scotland|Wales|Northern Ireland|"
    r"United Kingdom)\s*$")
_LEADING_CODE = re.compile(r"^[A-Z0-9]{3,10},\s*")


def tidy_site_name(name):
    """Tidy a personal eBird location name for display.

    Birders prefix their own locations with tags ("VISMIG, Troopers Hill, GB"),
    which are noise once the record is on a map.
    """
    n = str(name or "").strip()
    for _ in range(3):
        new = _COUNTRY_SUFFIX.sub("", n).strip()
        if new == n:
            break
        n = new
    n = _LEADING_CODE.sub("", n)
    return re.sub(r"\s+", " ", n).strip(" ,-")


# Birders abbreviate places as hard as they abbreviate birds.
_SITE_ABBREV = {
    "resv": "reservoir", "res": "reservoir", "resr": "reservoir",
    "gp": "gravel pits", "gps": "gravel pits",
    "nr": "nature reserve", "lnr": "local nature reserve",
    "nnr": "national nature reserve", "cp": "country park",
    "stw": "sewage works", "sf": "sewage farm", "sp": "sand pits",
    "pt": "point", "pk": "park", "cmn": "common", "flds": "fields",
    "mdws": "meadows", "wd": "wood", "hd": "head", "obs": "observatory",
}


def expand_abbrev(name):
    """Expand the shorthand birders write site names in."""
    words = str(name or "").split()
    out = []
    for w in words:
        key = re.sub(r"[^a-z]", "", w.lower())
        out.append(_SITE_ABBREV.get(key, w))
    return " ".join(out)


def name_variants(name):
    """Plausible shorter forms of a site name, longest first."""
    base = _clean_name(name)
    out = []
    seen = set()

    def push(v):
        k = norm(v)
        if k and k not in seen and k not in _STOPWORDS and len(k) >= 4:
            seen.add(k)
            out.append(k)

    push(base)
    expanded = expand_abbrev(base)
    if expanded != base:
        push(expanded)
    for part in _SPLIT_RE.split(base):
        push(part)
        ex = expand_abbrev(part)
        if ex != part:
            push(ex)
    # drop a trailing qualifier: "Chew Valley Lake Herriott's Pool" -> "Chew Valley Lake"
    words = base.split()
    if len(words) > 2:
        push(" ".join(words[:-1]))
    return out


def _geonames_path(download=True):
    """Path to the extracted GeoNames GB file, downloading it once if needed."""
    txt = GEONAMES_DIR / "GB.txt"
    if txt.exists():
        return txt
    if not download:
        return None
    GEONAMES_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = GEONAMES_DIR / "GB.zip"
    try:
        if not zip_path.exists():
            log.info("gazetteer: downloading GeoNames GB (~3.6 MB)")
            r = session().get(GEONAMES_URL, timeout=300)
            r.raise_for_status()
            zip_path.write_bytes(r.content)
        with zipfile.ZipFile(zip_path) as zf:
            # Extract only the one expected member, by exact name.
            if "GB.txt" not in zf.namelist():
                log.warning("gazetteer: GB.txt missing from GeoNames archive")
                return None
            txt.write_bytes(zf.read("GB.txt"))
        return txt
    except Exception as e:  # noqa: BLE001
        log.warning("gazetteer: GeoNames unavailable (%s)", e)
        return None


# Nominatim will happily answer "Stratford" with a residential street. A road,
# a house or a postcode is never where a bird was reported, and accepting one
# put 65 Chew Valley Lake records nine kilometres away in suburban Bristol.
_STREET_CLASSES = {"highway", "building", "place:house"}
_STREET_TYPES = {
    "residential", "road", "service", "unclassified", "tertiary", "secondary",
    "primary", "trunk", "motorway", "living_street", "pedestrian", "house",
    "house_number", "postcode", "yes",
}


def _too_broad(name):
    """Is this name a county, a country, or a word that means no place?"""
    key = norm(_clean_name(name))
    if not key:
        return True
    return key in _TOO_BROAD or key.removeprefix("the ") in _TOO_BROAD


def _is_street(hit):
    cls = (hit.get("class") or "").lower()
    typ = (hit.get("type") or "").lower()
    addr = (hit.get("addresstype") or "").lower()
    if cls in _STREET_CLASSES or f"{cls}:{typ}" in _STREET_CLASSES:
        return True
    if cls == "highway" or addr in {"road", "house", "house_number", "postcode"}:
        return True
    if cls in {"place", "building"} and typ in _STREET_TYPES:
        return True
    return False


def geocode_online(name, county_hint=None, bbox=None):
    """Last-resort geocode via Nominatim, cached permanently in SQLite.

    Only called for site names the offline gazetteer cannot place, which keeps
    request volume within OpenStreetMap's usage policy.
    """
    cleaned = norm(_clean_name(name))
    if not cleaned:
        return None
    # A bird is not a place. "starling, West Sussex, UK" came back as Starling
    # Close, a residential street, and five records were filed there.
    if cleaned in bird_name_words():
        return None
    # Nor is a county, a bare generic word, or a scrap of a sentence. Nominatim
    # answers all of them with something, and that something gets believed:
    # "West Sussex" became a pin near Billingshurst with Balearic Shearwaters
    # on it, "Heliport" a heliport 26 km from the right one, and "This is 13"
    # a cafe called This n That.
    if _too_broad(name):
        return None
    if any(ch.isdigit() for ch in cleaned):
        return None
    if len(cleaned) < 4 or len(cleaned.split()) > 6:
        return None
    query = ", ".join(x for x in (_clean_name(name), county_hint, "UK") if x)
    with db() as conn:
        row = conn.execute("SELECT * FROM geocode_cache WHERE query = ?",
                           (query,)).fetchone()
        if row:
            if row["lat"] is None:
                return None
            return {"name": row["name"], "lat": row["lat"], "lon": row["lon"],
                    "weight": 0.5, "kind": "nominatim", "origin": "nominatim"}

    lat = lon = disp = None
    try:
        # Ask for several and take the first that could plausibly be a
        # birding site, rather than blindly trusting the top hit.
        params = {"q": query, "format": "json", "countrycodes": "gb", "limit": 8}
        if bbox:
            s, w, n, e = bbox
            params.update({"viewbox": f"{w},{n},{e},{s}", "bounded": 1})
        res = request_json("GET", NOMINATIM, params=params,
                           limiter=_nominatim_limiter, retries=2, timeout=45)
        for hit in (res or []):
            if _is_street(hit):
                continue
            try:
                hlat, hlon = float(hit["lat"]), float(hit["lon"])
            except (KeyError, TypeError, ValueError):
                continue
            if not in_uk(hlat, hlon):
                continue
            lat, lon = hlat, hlon
            disp = hit.get("display_name", "").split(",")[0] or _clean_name(name)
            break
    except Exception as e:  # noqa: BLE001
        log.debug("gazetteer: nominatim failed for %r (%s)", query, e)
        return None

    with db() as conn:
        conn.execute("INSERT OR REPLACE INTO geocode_cache "
                     "(query, lat, lon, name, queried_at) VALUES (?,?,?,?,?)",
                     (query, lat, lon, disp, iso_now()))
    if lat is None:
        return None
    return {"name": disp, "lat": lat, "lon": lon, "weight": 0.5,
            "kind": "nominatim", "origin": "nominatim"}


def build(force=False):
    """Populate the gazetteer table from eBird hotspots plus known sites."""
    from .sources import ebird as ebird_src

    with db() as conn:
        have = conn.execute("SELECT COUNT(*) c FROM gazetteer").fetchone()["c"]
        if have and not force:
            log.info("gazetteer: %d entries already built", have)
            return have

    from .species import load as load_species
    sp_idx = load_species()

    rows = {}

    def add(name, lat, lon, region, kind, weight, origin):
        name = _clean_name(name)
        if not name or not in_uk(lat, lon):
            return
        # Birders name personal eBird locations after the bird they found
        # there ("Red-backed Shrike"), which would then swallow every mention
        # of that species in a blog post. A place may not be a species.
        if sp_idx.lookup(name):
            return
        for key in name_variants(name):
            prev = rows.get((key, round(lat, 5), round(lon, 5)))
            if prev and prev[6] >= weight:
                continue
            rows[(key, round(lat, 5), round(lon, 5))] = (
                key, name, float(lat), float(lon), region, kind, weight, origin)

    if CFG["ebird_api_token"]:
        counties = ebird_src.counties()
        log.info("gazetteer: fetching hotspots for %d counties", len(counties))
        for code, cname in counties:
            try:
                text = request_text(
                    EBIRD_HOTSPOT.format(region=code),
                    headers={"X-eBirdApiToken": CFG["ebird_api_token"]},
                    limiter=_limiter, params={"fmt": "csv"}, timeout=120)
            except Exception as e:  # noqa: BLE001
                log.warning("gazetteer: hotspots failed for %s (%s)", code, e)
                continue
            for rec in csv.reader(io.StringIO(text)):
                # locId,country,sub1,sub2,lat,lng,name,latestObsDt,nSpecies,...
                if len(rec) < 7:
                    continue
                try:
                    lat, lon = float(rec[4]), float(rec[5])
                except ValueError:
                    continue
                try:
                    weight = float(rec[8]) if len(rec) > 8 and rec[8] else 1.0
                except ValueError:
                    weight = 1.0
                add(rec[6], lat, lon, code, "hotspot", weight, "ebird_hotspot")
    else:
        log.warning("gazetteer: no eBird token, hotspot gazetteer unavailable")

    # GeoNames: villages, hills, waters and landmarks that are not birding
    # hotspots but still get named in reports.
    gn = _geonames_path(download=CFG.get("gazetteer", {}).get("download_geonames", True))
    if gn:
        n_before = len(rows)
        with open(gn, encoding="utf-8") as fh:
            for line in fh:
                f = line.split("\t")
                if len(f) < 9 or f[6] not in _GEONAMES_CLASSES:
                    continue
                try:
                    lat, lon = float(f[4]), float(f[5])
                except ValueError:
                    continue
                # Populated places outrank incidental spots on ties.
                weight = 3.0 if f[6] == "P" else 1.0
                add(f[1], lat, lon, None, f"geonames:{f[7]}", weight, "geonames")
        log.info("gazetteer: +%d entries from GeoNames", len(rows) - n_before)

    # Locations already seen in collected eBird records. These cover personal
    # patches that are not hotspots. BirdWeather is excluded on purpose: its
    # "sites" are recorder names ("BirdNET-Pi - delapole"), not places, and
    # iNaturalist place guesses are too coarse to geocode a report to.
    with db() as conn:
        for r in conn.execute(
                "SELECT site, region, AVG(lat) lat, AVG(lon) lon, COUNT(*) n "
                "FROM sighting WHERE source = 'ebird' "
                "AND site IS NOT NULL AND site != '' "
                "GROUP BY site, region"):
            add(tidy_site_name(r["site"]), r["lat"], r["lon"], r["region"],
                "observed", min(r["n"], 50) / 10.0, "sighting")

    with db() as conn:
        conn.execute("DELETE FROM gazetteer")
        conn.executemany(
            "INSERT OR REPLACE INTO gazetteer "
            "(name_key, name, lat, lon, region, kind, weight, origin) "
            "VALUES (?,?,?,?,?,?,?,?)", list(rows.values()))
    log.info("gazetteer: %d entries", len(rows))
    return len(rows)


class Gazetteer:
    """Name -> coordinate lookup, scoped to a bounding box per query."""

    def __init__(self, entries):
        self.by_key = {}
        for e in entries:
            self.by_key.setdefault(e["name_key"], []).append(e)
        self._keys = list(self.by_key)

    @classmethod
    def load(cls):
        with db() as conn:
            entries = [dict(r) for r in conn.execute("SELECT * FROM gazetteer")]
        if not entries:
            build()
            with db() as conn:
                entries = [dict(r) for r in conn.execute("SELECT * FROM gazetteer")]
        g = cls(entries)
        g.bird_words = bird_name_words()
        g._word_sites = None          # built on first use, see _in_named_site
        return g

    @staticmethod
    def _best(cands, bbox):
        """The likeliest of several same-named places inside a county box.

        Weight alone - the number of eBird records at a hotspot - picked
        Salcombe's Warren Point for a Dawlish Warren blog, 49 km away, because
        Salcombe has 38 records and Dawlish's point has 1. Distance to the
        middle of the blog's own county comes first now, bucketed to 8 km so
        that among places in the same area eBird volume still decides. That
        ordering fixes Warren Point and keeps Stratford Hide (17 km from the
        Avon centre) ahead of Stratford Park in Stroud (42 km).
        """
        if not cands:
            return None
        if not bbox:
            return max(cands, key=lambda c: c["weight"])
        s_, w_, n_, e_ = bbox
        clat, clon = (s_ + n_) / 2, (w_ + e_) / 2
        scale = math.cos(math.radians(clat))

        def rank(c):
            dkm = math.hypot((c["lat"] - clat) * 111.0,
                             (c["lon"] - clon) * 111.0 * scale)
            return (int(dkm // 8), -c["weight"])

        return min(cands, key=rank)

    def _in_box(self, cands, bbox):
        if not bbox:
            return cands
        s, w, n, e = bbox
        return [c for c in cands
                if s <= c["lat"] <= n and w <= c["lon"] <= e]

    def lookup(self, name, bbox=None, fuzzy=True):
        """Best match for a site name within bbox, or None."""
        # The same two guards the prose scanner uses. Without them here a blog
        # site of literally "South Shore" resolved to Blackpool's South Shore,
        # 28 km from the Heysham records it was attached to.
        if _too_broad(name) or norm(_clean_name(name)) in bird_name_words():
            return None
        for key in name_variants(name):
            cands = self._in_box(self.by_key.get(key, []), bbox)
            if cands:
                return self._best(cands, bbox)
        if not fuzzy:
            return None

        # A birding site that the blogs call by one word of its full name.
        # "Stratford" is Chew Valley Lake AWT NR--Stratford Hide to eBird, and
        # matching that is far better than asking Nominatim, which answers with
        # a street. Checked before the fuzzy pass because it is exact on a word
        # rather than approximate on a string.
        hit = self._in_named_site(name, bbox)
        if hit:
            return hit

        # Fuzzy fallback, restricted to keys of similar length.
        target = norm(_clean_name(name))
        if len(target) < 6:
            return None
        best, best_ratio = None, 0.0
        for key in difflib.get_close_matches(target, self._keys, n=6, cutoff=0.88):
            cands = self._in_box(self.by_key.get(key, []), bbox)
            if not cands:
                continue
            ratio = difflib.SequenceMatcher(None, target, key).ratio()
            if ratio > best_ratio:
                best, best_ratio = max(cands, key=lambda c: c["weight"]), ratio
        return best

    def _in_named_site(self, name, bbox):
        """A recognised birding site whose full name contains this word."""
        target = norm(_clean_name(name))
        if len(target) < 5 or " " in target or target in _STOPWORDS:
            return None
        if target in bird_name_words():
            return None
        if self._word_sites is None:
            self._word_sites = {}
            for key, entries in self.by_key.items():
                hot = [e for e in entries if e.get("kind") == "hotspot"]
                if not hot:
                    continue
                for word in key.split():
                    if len(word) >= 5:
                        self._word_sites.setdefault(word, []).extend(hot)
        cands = self._in_box(self._word_sites.get(target, []), bbox)
        if not cands:
            return None
        return self._best(cands, bbox)

    def find_in_text(self, text, bbox=None, max_words=4, min_len=6):
        """The best-known place named anywhere in a piece of free text.

        Tries word n-grams longest-first against the name index rather than
        scanning every name against the string: with 160,000 entries the
        latter is far too slow to run per social post, and matching on word
        boundaries is what keeps "Camborne Road" from being read as the town
        of Camborne.

        The n-gram must be capitalised in the original. Without that, the
        ordinary word "letters" matches the Highland hamlet of Letters, and
        "roadside" matches a farm called Roadside.
        """
        toks = [m.group(0) for m in _WORD_RE.finditer(text or "")]
        best = None
        for size in range(min(max_words, len(toks)), 0, -1):
            for i in range(len(toks) - size + 1):
                if not toks[i][:1].isupper():
                    continue
                key = norm(" ".join(toks[i:i + size]))
                if len(key) < min_len or key in _STOPWORDS:
                    continue
                # There are places in Britain called Cuckoo, Nightingale,
                # Cranes, Harrier and Caspian, and a post naming a bird is
                # not naming any of them. Reject a match only when the whole
                # matched phrase IS a bird name - "Barn Elms" and "Red Kite
                # Retreat" still resolve, because their phrase is longer.
                if key in getattr(self, "bird_words", ()):
                    continue
                cands = self._in_box(self.by_key.get(key, []), bbox)
                cands = [c for c in cands
                         if c.get("kind") not in _PROSE_EXCLUDED_KINDS]
                if not cands:
                    continue
                hit = max(cands, key=lambda c: c["weight"])
                # Within a size, later wins. People write the bird first and
                # the place last ("Black Redstart, Camborne Road, Yeovil"),
                # so the final place named is the one they actually mean.
                best = (len(key), hit)
            if best:
                return best[1]
        return None

    def names_in_box(self, bbox, min_len=5):
        """Site names inside bbox, longest first - used to scan prose.

        The blog prose path goes through here, not through `find_in_text`, so
        the guards that stop a bird or a hotel being read as a place have to be
        applied here too - they were not, and the blogs kept resolving "Norfolk"
        to the Norfolk & Norwich University Hospital, 60 km from Holme.
        """
        birds = bird_name_words()
        out = []
        for key, cands in self.by_key.items():
            if len(key) < min_len or key in _STOPWORDS:
                continue
            # A bird, a county, a country or a bare generic word is not a site.
            if key in birds or key in _TOO_BROAD:
                continue
            inside = [c for c in self._in_box(cands, bbox)
                      if c.get("kind") not in _PROSE_EXCLUDED_KINDS]
            if inside:
                out.append((key, self._best(inside, bbox)))
        out.sort(key=lambda kv: -len(kv[0]))
        return out
