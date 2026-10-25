"""Backdrop geometry for the animation studio.

The studio does not use map tiles: it draws its own world so that every frame
is deterministic and under our control (no tile loading mid-render, no
attribution burned into the video, no key). That needs two things this module
builds:

* `web/data/geo.json`  - land polygons for the UK and its neighbours, clipped
  to the view and simplified to roughly one vertex per output pixel.
* `web/data/cities.json` - populated places with populations, which become the
  city lights that come on as night crosses the country.
"""
import json
import math

from .config import DATA, WEB_DATA
from .util import log, session

# Natural Earth, via the project's own GeoJSON builds.
NE_BASE = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
           "master/geojson")
LAND_SOURCE = f"{NE_BASE}/ne_10m_admin_0_countries.geojson"
LAKE_SOURCE = f"{NE_BASE}/ne_10m_lakes.geojson"

SRC_DIR = DATA / "geo_src"

# The studio's world: Britain and Ireland with enough of the near Continent
# and Atlantic for context.
VIEW = {"south": 33.0, "west": -27.0, "north": 72.5, "east": 46.0}

# Vertices closer together than this are dropped. 0.004 deg is about 300 m,
# below a pixel at the sizes the studio renders.
SIMPLIFY_TOLERANCE = 0.004
MIN_RING_AREA = 2.5e-5      # square degrees; drops specks too small to see


def _fetch(url, name):
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    path = SRC_DIR / name
    if path.exists() and path.stat().st_size > 1000:
        return json.loads(path.read_text())
    log.info("geodata: downloading %s", name)
    r = session().get(url, timeout=300)
    r.raise_for_status()
    path.write_bytes(r.content)
    return json.loads(r.text)


def _clip_ring(ring, view):
    """Sutherland-Hodgman clip of a ring to the view rectangle."""
    def inside(p, edge):
        if edge == "w":
            return p[0] >= view["west"]
        if edge == "e":
            return p[0] <= view["east"]
        if edge == "s":
            return p[1] >= view["south"]
        return p[1] <= view["north"]

    def cut(a, b, edge):
        if edge in ("w", "e"):
            x = view["west"] if edge == "w" else view["east"]
            t = (x - a[0]) / (b[0] - a[0]) if b[0] != a[0] else 0.0
            return [x, a[1] + t * (b[1] - a[1])]
        y = view["south"] if edge == "s" else view["north"]
        t = (y - a[1]) / (b[1] - a[1]) if b[1] != a[1] else 0.0
        return [a[0] + t * (b[0] - a[0]), y]

    out = [list(p) for p in ring]
    for edge in ("w", "e", "s", "n"):
        if not out:
            return []
        buf = []
        for i, cur in enumerate(out):
            prev = out[i - 1]
            cur_in, prev_in = inside(cur, edge), inside(prev, edge)
            if cur_in:
                if not prev_in:
                    buf.append(cut(prev, cur, edge))
                buf.append(cur)
            elif prev_in:
                buf.append(cut(prev, cur, edge))
        out = buf
    return out


def _simplify(points, tol):
    """Douglas-Peucker, iterative so long coastlines cannot blow the stack."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        ax, ay = points[lo]
        bx, by = points[hi]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, best_d = -1, tol
        for i in range(lo + 1, hi):
            px, py = points[i]
            if norm == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best_d:
                best, best_d = i, d
        if best > 0:
            keep[best] = True
            stack.append((lo, best))
            stack.append((best, hi))
    return [p for p, k in zip(points, keep) if k]


def _ring_area(ring):
    a = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def _rings_from_feature(geom, view):
    out = []
    gtype = geom.get("type")
    polys = []
    if gtype == "Polygon":
        polys = [geom["coordinates"]]
    elif gtype == "MultiPolygon":
        polys = geom["coordinates"]
    for poly in polys:
        for ring in poly:
            clipped = _clip_ring(ring, view)
            if len(clipped) < 4:
                continue
            simple = _simplify(clipped, SIMPLIFY_TOLERANCE)
            if len(simple) < 4 or _ring_area(simple) < MIN_RING_AREA:
                continue
            out.append([[round(x, 4), round(y, 4)] for x, y in simple])
    return out


def _bbox_overlaps(geom, view):
    xs, ys = [], []

    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0])
            ys.append(c[1])
        else:
            for sub in c:
                walk(sub)

    walk(geom["coordinates"])
    return not (max(xs) < view["west"] or min(xs) > view["east"]
                or max(ys) < view["south"] or min(ys) > view["north"])


def build_land(view=None):
    view = view or VIEW
    data = _fetch(LAND_SOURCE, "ne_10m_admin_0_countries.geojson")
    land = []
    for feat in data.get("features", []):
        geom = feat.get("geometry") or {}
        if not geom.get("coordinates") or not _bbox_overlaps(geom, view):
            continue
        land.extend(_rings_from_feature(geom, view))

    lakes = []
    try:
        lk = _fetch(LAKE_SOURCE, "ne_10m_lakes.geojson")
        for feat in lk.get("features", []):
            geom = feat.get("geometry") or {}
            if not geom.get("coordinates") or not _bbox_overlaps(geom, view):
                continue
            lakes.extend(_rings_from_feature(geom, view))
    except Exception as e:  # noqa: BLE001 - lakes are decoration
        log.warning("geodata: lakes unavailable (%s)", e)

    out = {"view": view, "land": land, "lakes": lakes}
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    path = WEB_DATA / "geo.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    log.info("geodata: %d land rings, %d lakes -> %s (%.1f MB)",
             len(land), len(lakes), path.name, path.stat().st_size / 1e6)
    return path


def build_cities(min_pop=1000, view=None):
    """City lights, from the GeoNames extract the gazetteer already uses."""
    from .gazetteer import _geonames_path

    view = view or VIEW
    gn = _geonames_path(download=True)
    if not gn:
        log.warning("geodata: no GeoNames file, skipping city lights")
        return None

    cities = []
    with open(gn, encoding="utf-8") as fh:
        for line in fh:
            f = line.split("\t")
            if len(f) < 15 or f[6] != "P":
                continue
            try:
                lat, lon, pop = float(f[4]), float(f[5]), int(f[14] or 0)
            except ValueError:
                continue
            if pop < min_pop:
                continue
            if not (view["south"] <= lat <= view["north"]
                    and view["west"] <= lon <= view["east"]):
                continue
            cities.append([round(lon, 3), round(lat, 3), pop])

    cities.sort(key=lambda c: -c[2])
    path = WEB_DATA / "cities.json"
    path.write_text(json.dumps({"cities": cities}, separators=(",", ":")))
    log.info("geodata: %d city lights -> %s", len(cities), path.name)
    return path


def build(force=False):
    geo = WEB_DATA / "geo.json"
    cities = WEB_DATA / "cities.json"
    if not force and geo.exists() and cities.exists():
        log.info("geodata: already built")
        return
    build_land()
    build_cities()


if __name__ == "__main__":
    from .util import setup_logging
    setup_logging()
    build(force=True)
