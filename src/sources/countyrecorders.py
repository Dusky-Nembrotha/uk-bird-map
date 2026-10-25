"""County recorder sightings pages that publish coordinates.

Most county sightings are prose and have to be geocoded from a place name.
These two publish a position with every record, which makes them the most
precise non-checklist data in the project:

* **Kent Ornithological Society** gives an Ordnance Survey grid reference per
  visit - four-figure (a 1 km square) or six-figure (100 m) - which converts
  exactly. It also gives the visit's time window, the weather, the observer
  and a count for every species.
* **Sussex Ornithological Society** gives decimal latitude and longitude for
  any record whose submitter dropped a map pin, which is most but not all of
  them. The rest are left out rather than guessed at.

Both are public, unauthenticated pages. Kent's robots.txt permits
`/index.php/sightings/*`; Sussex's explicitly allows the admin-ajax endpoint
its own page uses. Neither is paginated for non-members, so both are polled
and accumulated rather than back-filled.
"""
import html as htmllib
import re
from datetime import datetime

from ..osgrid import gridref_to_latlon
from ..species import load as load_species
from ..util import RateLimiter, in_uk, iso_now, log, request_text, since_date

_limiter = RateLimiter(2.0)       # these are small sites; be gentle

SOURCES = {
    "kentos": {
        "name": "Kent Ornithological Society",
        "url": "https://www.kentos.org.uk/index.php/sightings/bird-news?view=news",
        "region": "Kent",
    },
    "sussexos": {
        "name": "Sussex Ornithological Society",
        "url": "https://sos.org.uk/recent-sightings/",
        "region": "Sussex",
    },
}

_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"[\s ]+")


def _text(fragment):
    return _WS.sub(" ", htmllib.unescape(_TAG.sub(" ", fragment or ""))).strip()


def _parse_date(text):
    """'Saturday 17 October 2026' or '22 Oct 2026' -> ISO date."""
    t = _WS.sub(" ", (text or "").replace(",", "")).strip()
    for fmt in ("%A %d %B %Y", "%d %B %Y", "%d %b %Y", "%A %d %b %Y"):
        try:
            return datetime.strptime(t, fmt).date().isoformat()
        except ValueError:
            pass
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})", t)
    if m:
        for fmt in ("%d %B %Y", "%d %b %Y"):
            try:
                return datetime.strptime(" ".join(m.groups()), fmt).date().isoformat()
            except ValueError:
                pass
    return None


# ------------------------------------------------------------------- Kent

# <h4>Site <span>(14:05 to 17:15)</span> … <span>[Observer]</span>
#    <span class="gc-birdsightings-gridrefs" data-gridref="TR0064">
_KENT_DATE = re.compile(r'<div class="gc-birdsightings-list-date">(.*?)(?=<div class="gc-birdsightings-list-date">|\Z)', re.S)
_KENT_H3 = re.compile(r"<h3[^>]*>(.*?)</h3>", re.S)
_KENT_VISIT = re.compile(r'<div class="gc-birdsightings-list-visit">(.*?)(?=<div class="gc-birdsightings-list-visit">|\Z)', re.S)
_KENT_H4 = re.compile(r"<h4[^>]*>(.*?)</h4>", re.S)
_KENT_GRID = re.compile(r'data-gridref="([A-Z0-9]+)"')
_KENT_TIME = re.compile(r"<span[^>]*>\s*\(([^)]*\d{1,2}:\d{2}[^)]*)\)\s*</span>")
_KENT_OBS = re.compile(r"\[([^\]]{2,60})\]")
# "2&nbsp;<span …>Common Scoter</span> (notes)"
_KENT_REC = re.compile(r"(?:(\d[\d,]*)\s*)?<span[^>]*>([^<]{3,60})</span>\s*(?:\(([^)]*)\))?")


def fetch_kent(idx, cutoff, cfg):
    page = request_text(cfg["url"], limiter=_limiter, timeout=90)
    rows = {}
    for block in _KENT_DATE.findall(page):
        h3 = _KENT_H3.search(block)
        day = _parse_date(_text(h3.group(1))) if h3 else None
        if not day or day < cutoff.isoformat():
            continue
        for visit in _KENT_VISIT.findall(block):
            h4 = _KENT_H4.search(visit)
            if not h4:
                continue
            head = h4.group(1)

            grid = _KENT_GRID.search(head)
            pos = gridref_to_latlon(grid.group(1)) if grid else None
            if not pos or not in_uk(pos[0], pos[1]):
                continue
            lat, lon, square = pos

            # The site name is whatever precedes the first <span> in the head.
            site = _text(head.split("<span", 1)[0]) or "Kent"
            tm = _KENT_TIME.search(head)
            start_time = None
            if tm:
                hm = re.search(r"(\d{1,2}:\d{2})", tm.group(1))
                start_time = hm.group(1) if hm else None
            obs = _KENT_OBS.search(_text(head))
            observer = obs.group(1).strip() if obs else None

            # The count and the species name are separated by a literal
            # &nbsp; in the markup, which \s does not match.
            body = visit[h4.end():].replace("&nbsp;", " ")
            for count_s, name, note in _KENT_REC.findall(body):
                common, sci, key = idx.canonical(_text(name), None)
                if not key:
                    continue
                try:
                    count = int(count_s.replace(",", "")) if count_s else None
                except ValueError:
                    count = None
                uid = f"kentos:{day}:{site[:28]}:{key}"
                prev = rows.get(uid)
                if prev and (prev["count"] or 0) >= (count or 0):
                    continue
                rows[uid] = {
                    "uid": uid, "source": "countyrecorder",
                    "common": common, "sci": sci, "species_key": key,
                    "count": count, "obs_date": day, "obs_time": start_time,
                    "lat": lat, "lon": lon,
                    # A grid reference describes a square, not a point.
                    "precision": "exact" if square <= 100 else "site",
                    "site": site, "region": cfg["region"], "observer": observer,
                    "url": cfg["url"], "confidence": None, "notable": 0,
                    "extra": {"recorder": "Kent Ornithological Society",
                              "gridref": grid.group(1),
                              "square_m": square,
                              "note": (_text(note) or None)},
                    "fetched_at": iso_now(),
                }
    return rows


# ----------------------------------------------------------------- Sussex

_SOS_MAP = re.compile(r"RecentS_ShowMap\(\s*'(\d+)'\s*,\s*'(-?[\d.]+)'\s*,\s*'(-?[\d.]+)'")
_SOS_GROUP = re.compile(r'<div class="sighting-group">(.*?)(?=<div class="sighting-group">|\Z)', re.S)
_SOS_DATE = re.compile(r'<div class="sighting-date">\s*<b>(.*?)</b>', re.S)
_SOS_ITEM = re.compile(r'<div class="sighting-item">(.*?)(?=<div class="sighting-item">|\Z)', re.S)
_SOS_TITLE = re.compile(r'<div class="sighting-title">\s*<b>(.*?)</b>', re.S)
_SOS_FULL = re.compile(r'<span class="full-content">(.*?)</span>', re.S)
_SOS_ID = re.compile(r'divMapBtn(\d+)')
_SOS_POSTER = re.compile(r"posted by ([^<]{2,60}?) on ", re.I)


def fetch_sussex(idx, cutoff, cfg, matcher):
    page = request_text(cfg["url"], limiter=_limiter, timeout=90)
    coords = {mid: (float(la), float(lo)) for mid, la, lo in _SOS_MAP.findall(page)}
    rows = {}
    for group in _SOS_GROUP.findall(page):
        dm = _SOS_DATE.search(group)
        day = _parse_date(_text(dm.group(1))) if dm else None
        if not day or day < cutoff.isoformat():
            continue
        for item in _SOS_ITEM.findall(group):
            mid = _SOS_ID.search(item)
            pos = coords.get(mid.group(1)) if mid else None
            # No pin, no position: these are left out rather than guessed at.
            if not pos or not in_uk(pos[0], pos[1]):
                continue
            lat, lon = pos

            tm = _SOS_TITLE.search(item)
            title = _text(tm.group(1)) if tm else ""
            full = _SOS_FULL.search(item)
            body = _text(full.group(1)) if full else _text(item)
            poster = _SOS_POSTER.search(_text(item))

            found = matcher.find(title) or matcher.find(body)
            for key, count, _phrase in found:
                rec = idx.by_key.get(key)
                if rec is None:
                    continue
                uid = f"sussexos:{mid.group(1)}:{key}"
                prev = rows.get(uid)
                if prev and (prev["count"] or 0) >= (count or 0):
                    continue
                rows[uid] = {
                    "uid": uid, "source": "countyrecorder",
                    "common": rec["common"], "sci": rec["sci"], "species_key": key,
                    "count": count, "obs_date": day, "obs_time": None,
                    "lat": lat, "lon": lon, "precision": "exact",
                    "site": title[:70] or "Sussex", "region": cfg["region"],
                    "observer": poster.group(1).strip() if poster else None,
                    "url": cfg["url"], "confidence": None, "notable": 0,
                    "extra": {"recorder": "Sussex Ornithological Society",
                              "snippet": body[:220]},
                    "fetched_at": iso_now(),
                }
    return rows


def fetch(days_back=None):
    idx = load_species()
    from .blogs import SpeciesMatcher
    matcher = SpeciesMatcher(idx)
    cutoff = since_date(days_back)

    rows = {}
    try:
        kent = fetch_kent(idx, cutoff, SOURCES["kentos"])
        rows.update(kent)
        log.info("countyrecorders: kentos -> %d records", len(kent))
    except Exception as e:  # noqa: BLE001
        log.warning("countyrecorders: kentos failed (%s)", e)
    try:
        sussex = fetch_sussex(idx, cutoff, SOURCES["sussexos"], matcher)
        rows.update(sussex)
        log.info("countyrecorders: sussexos -> %d records", len(sussex))
    except Exception as e:  # noqa: BLE001
        log.warning("countyrecorders: sussexos failed (%s)", e)

    log.info("countyrecorders: %d records total", len(rows))
    return list(rows.values())
