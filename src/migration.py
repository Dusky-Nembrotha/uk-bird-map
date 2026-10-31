"""A year of one species turned into a flow field the studio can fly.

The studio already advects particles through a lat/lon grid of u/v vectors -
that is how the weather layer draws wind. This writes the same shape of file
from bird records instead, so the particle engine can be pointed at a species
rather than at the weather.

The method, and its limits:

  * Records are binned by week onto a coarse grid, then smoothed, giving a
    weekly abundance surface.
  * Movement between consecutive weeks is recovered by Horn-Schunck optical
    flow over those two surfaces. This is the honest name for what GeoPanda
    calls a migration model: it is not observed movement. No goose was
    tracked. It is the direction the *centre of the population* must have
    shifted for one week's distribution to become the next, which is a real
    quantity about the species and emphatically not a flight path.
  * Abundance is reports, not birds, so it carries observer effort with it.
    Britain looks busier than Iceland partly because more people are looking.

    python3 -m src.migration --species "Anser brachyrhynchus"
"""
import argparse
import json
import sqlite3
from datetime import date, timedelta

import numpy as np

from .backfill import DB_PATH
from .config import AREA_BBOX, DATA, WEB_DATA
from .util import log, setup_logging

DLAT, DLON = 0.9, 1.8           # grid step, degrees
SMOOTH_PASSES = 3
SMOOTH_RADIUS = 2
HS_ALPHA = 0.08                 # Horn-Schunck smoothness weight
HS_ITERS = 180
# Horn-Schunck assumes the thing being tracked moves less than a cell or two
# per step. A goose crossing from Iceland to the Solway covers eight cells in
# a week, which plain HS simply cannot see - it reports nearly nothing. So the
# flow is solved coarse-to-fine: a quarter-size grid finds the big shift, and
# each finer level only has to correct what is left.
HS_LEVELS = 3
# A week's surface is normalised against this percentile of the whole year,
# not against its own maximum: one roost of twenty thousand would otherwise
# make every other week look empty.
CLIP_PCT = 99.0
# Below this share of the clipped maximum, a cell has too few birds for its
# flow to mean anything, and the field is faded out rather than trusted.
FLOW_FLOOR = 0.06


def _grid():
    b = AREA_BBOX
    rows = int((b["north"] - b["south"]) / DLAT) + 1
    cols = int((b["east"] - b["west"]) / DLON) + 1
    return {"lat0": b["south"], "lon0": b["west"],
            "dlat": DLAT, "dlon": DLON, "rows": rows, "cols": cols}


def _load(species, start=None, end=None):
    """One species over a window.

    The window matters more than it looks. GBIF republishes eBird in batches,
    so the last several months of any download are a fraction of what they
    will eventually hold - here October 2026 arrived with 1,242 records
    against 6,948 for October 2025. Building a year that runs up to today
    therefore ends in a fade that is an artefact of publishing, not of birds.
    """
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    sql = ("SELECT obs_date, lat, lon, count, sci, common FROM occurrence"
           " WHERE (sci LIKE ? OR common LIKE ?)")
    args = [f"{species}%", species]
    if start:
        sql += " AND obs_date >= ?"
        args.append(start)
    if end:
        sql += " AND obs_date <= ?"
        args.append(end)
    rows = conn.execute(sql + " ORDER BY obs_date", args).fetchall()
    conn.close()
    if not rows:
        raise SystemExit(f"No backfilled records for {species!r}."
                         f" Run: python3 -m src.backfill --species {species!r}")
    return rows


def _english_name(sci):
    """GBIF hands back whichever vernacular the publishing dataset carried, so
    a Norwegian checklist makes a Pink-footed Goose a Spetsbergsgas. Our own
    species index is English by construction, so ask that first."""
    try:
        conn = sqlite3.connect(f"file:{DATA / 'sightings.db'}?mode=ro", uri=True)
        row = conn.execute("SELECT common FROM species WHERE sci = ?",
                           (sci.split(" (")[0].strip(),)).fetchone()
        conn.close()
        if row and row[0]:
            return row[0]
    except sqlite3.Error:
        pass
    return None


def _blur(a, radius, passes):
    """Separable box blur, repeated - close enough to a Gaussian here."""
    out = a.astype(float)
    k = 2 * radius + 1
    for _ in range(passes):
        pad = np.pad(out, ((0, 0), (radius, radius)), mode="edge")
        out = np.apply_along_axis(
            lambda r: np.convolve(r, np.ones(k) / k, mode="valid"), 1, pad)
        pad = np.pad(out, ((radius, radius), (0, 0)), mode="edge")
        out = np.apply_along_axis(
            lambda c: np.convolve(c, np.ones(k) / k, mode="valid"), 0, pad)
    return out


def _weekly_points(rows, weeks, first):
    """The actual report positions, week by week.

    The grid carries the modelled flow; these carry the observations. Drawing
    both is what the reference does - bright dots are geese somebody saw,
    lines are where the model says they went - and it keeps the two honestly
    separate rather than smearing the records into the model.
    """
    buckets = [[] for _ in weeks]
    for (iso, lat, lon, _cnt, _sci, _com) in rows:
        w = (date.fromisoformat(iso) - first).days // 7
        if 0 <= w < len(weeks):
            buckets[w].extend((round(lat, 2), round(lon, 2)))
    return buckets


def _weekly_surfaces(rows, g):
    """One smoothed abundance surface per week, plus the week start dates."""
    days = [date.fromisoformat(r[0]) for r in rows]
    first = min(days) - timedelta(days=min(days).weekday())
    last = max(days)
    weeks = []
    d = first
    while d <= last:
        weeks.append(d)
        d += timedelta(days=7)

    stack = np.zeros((len(weeks), g["rows"], g["cols"]))
    for (iso, lat, lon, cnt, _sci, _com), day in zip(rows, days):
        w = (day - first).days // 7
        r = int(round((lat - g["lat0"]) / g["dlat"]))
        c = int(round((lon - g["lon0"]) / g["dlon"]))
        if 0 <= w < len(weeks) and 0 <= r < g["rows"] and 0 <= c < g["cols"]:
            # A report, not a headcount. Flock sizes span four orders of
            # magnitude and would otherwise let one count stand in for a county.
            stack[w, r, c] += 1.0
    for w in range(len(weeks)):
        stack[w] = _blur(stack[w], SMOOTH_RADIUS, SMOOTH_PASSES)
    return weeks, stack


def _downsample(a):
    r, c = a.shape[0] // 2 * 2, a.shape[1] // 2 * 2
    return a[:r, :c].reshape(r // 2, 2, c // 2, 2).mean(axis=(1, 3))


def _upsample(a, shape):
    out = np.repeat(np.repeat(a, 2, axis=0), 2, axis=1)
    return np.pad(out[:shape[0], :shape[1]],
                  ((0, max(0, shape[0] - out.shape[0])),
                   (0, max(0, shape[1] - out.shape[1]))), mode="edge")


def _warp(a, u, v):
    """a sampled at (x+u, y+v) - what a looks like once the flow is applied."""
    rows, cols = a.shape
    yy, xx = np.mgrid[0:rows, 0:cols]
    sy = np.clip(yy + v, 0, rows - 1)
    sx = np.clip(xx + u, 0, cols - 1)
    y0, x0 = np.floor(sy).astype(int), np.floor(sx).astype(int)
    y1, x1 = np.minimum(y0 + 1, rows - 1), np.minimum(x0 + 1, cols - 1)
    fy, fx = sy - y0, sx - x0
    return ((a[y0, x0] * (1 - fx) + a[y0, x1] * fx) * (1 - fy)
            + (a[y1, x0] * (1 - fx) + a[y1, x1] * fx) * fy)


def _flow(a, b, levels=HS_LEVELS):
    """Coarse-to-fine dense flow, in cells per step."""
    pyr_a, pyr_b = [a], [b]
    for _ in range(levels - 1):
        if min(pyr_a[-1].shape) < 6:
            break
        pyr_a.append(_downsample(pyr_a[-1]))
        pyr_b.append(_downsample(pyr_b[-1]))
    u = np.zeros_like(pyr_a[-1])
    v = np.zeros_like(pyr_a[-1])
    for lvl in range(len(pyr_a) - 1, -1, -1):
        A, B = pyr_a[lvl], pyr_b[lvl]
        if u.shape != A.shape:
            u = _upsample(u, A.shape) * 2
            v = _upsample(v, A.shape) * 2
        du, dv = _horn_schunck(_warp(A, u, v), B)
        u, v = u + du, v + dv
    return u, v


def _horn_schunck(a, b, alpha=HS_ALPHA, iters=HS_ITERS):
    """Dense flow from surface a to surface b, in cells per step."""
    Ix = (np.gradient(a, axis=1) + np.gradient(b, axis=1)) / 2
    Iy = (np.gradient(a, axis=0) + np.gradient(b, axis=0)) / 2
    It = b - a
    u = np.zeros_like(a)
    v = np.zeros_like(a)
    kernel = np.array([[1 / 12, 1 / 6, 1 / 12],
                       [1 / 6, 0, 1 / 6],
                       [1 / 12, 1 / 6, 1 / 12]])
    for _ in range(iters):
        ub = _convolve3(u, kernel)
        vb = _convolve3(v, kernel)
        d = alpha ** 2 + Ix ** 2 + Iy ** 2
        common = (Ix * ub + Iy * vb + It) / d
        u = ub - Ix * common
        v = vb - Iy * common
    return u, v


def _convolve3(a, k):
    p = np.pad(a, 1, mode="edge")
    out = np.zeros_like(a)
    for dy in range(3):
        for dx in range(3):
            if k[dy, dx]:
                out += k[dy, dx] * p[dy:dy + a.shape[0], dx:dx + a.shape[1]]
    return out


def build(species, out_path=None, start=None, end=None):
    rows = _load(species, start, end)
    g = _grid()
    weeks, stack = _weekly_surfaces(rows, g)
    first = weeks[0]
    points = _weekly_points(rows, weeks, first)
    log.info("%s: %d records over %d weeks, grid %dx%d",
             species, len(rows), len(weeks), g["rows"], g["cols"])

    cap = np.percentile(stack[stack > 0], CLIP_PCT) if (stack > 0).any() else 1.0
    norm = np.clip(stack / (cap or 1.0), 0, 1)

    us, vs, ns = [], [], []
    # Flow is solved on surfaces normalised week by week. What matters for
    # movement is where the birds are, not how many were reported that week;
    # leaving the raw counts in meant a quiet week had a flat surface, no
    # gradient, and so no flow at all.
    shape = stack / np.maximum(stack.max(axis=(1, 2), keepdims=True), 1e-9)
    for w in range(len(weeks)):
        a = shape[w]
        b = shape[min(len(weeks) - 1, w + 1)]
        u, v = _flow(a, b)
        # Flow only where there are birds to carry it. Over empty ground the
        # optical flow is fitting noise between two near-zero surfaces, and it
        # shows: in high summer, with the geese in Iceland and the map that
        # should be still, every cell had an opinion about where they were
        # going. Fading the field out with abundance is also what the
        # reference does - its streaks disappear entirely in June.
        gate = np.clip(norm[w] / FLOW_FLOOR, 0, 1)
        u *= gate
        v *= gate
        # cells/week -> degrees/day, which is a quantity with a meaning
        us.append(np.round(u * g["dlon"] / 7.0, 4).ravel().tolist())
        vs.append(np.round(v * g["dlat"] / 7.0, 4).ravel().tolist())
        ns.append(np.round(norm[w], 4).ravel().tolist())

    sci = rows[0][4] or species
    common = _english_name(sci) or species
    payload = {
        "species": {"common": common, "sci": sci},
        "records": len(rows),
        "grid": g,
        "times": [w.isoformat() for w in weeks],
        "u": us, "v": vs, "n": ns,
        "points": points,
        "units": {"points": "observed report positions, [lat,lon,...] per week",
                  "u": "degrees longitude per day", "v": "degrees latitude per day",
                  "n": "reports per cell, smoothed, clipped at the "
                       f"{CLIP_PCT:g}th percentile of the year"},
        "method": "Horn-Schunck optical flow between consecutive weekly "
                  "abundance surfaces. Modelled population shift, not tracked "
                  "birds, and abundance carries observer effort with it.",
        "generated": date.today().isoformat(),
    }
    out = out_path or (WEB_DATA / "migration.json")
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(",", ":")))
    speed = np.hypot(np.array(us[-10]), np.array(vs[-10]))
    log.info("wrote %s (%.1f MB), typical speed %.3f deg/day, peak %.3f",
             out, out.stat().st_size / 1e6, float(np.median(speed)), float(speed.max()))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--species", required=True)
    ap.add_argument("--from", dest="start", help="YYYY-MM-DD")
    ap.add_argument("--to", dest="end", help="YYYY-MM-DD")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    setup_logging(a.verbose)
    build(a.species, start=a.start, end=a.end)


if __name__ == "__main__":
    main()
