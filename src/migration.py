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
# A week-to-week change smaller than this share of the population is not a
# migration, it is who went birding where. Arcs below it are dropped. The
# value is the 90th percentile of observed weekly change: the distribution is
# spread over some two hundred cells, so a single cell holds half a percent of
# the birds and shifts by a twentieth of that in a week. Guessing a round
# number here produced no arcs at all.
MOVE_FLOOR = 0.0004
# Geese cross oceans; they do not teleport. Pairings longer than this are an
# artefact of matching a source to a sink that has nothing to do with it.
MAX_HOP_KM = 2200
# Weekly surfaces are averaged over this many weeks before differencing, so a
# single quiet week does not read as a mass departure.
TEMPORAL_SMOOTH = 3
MAX_ARCS = 420
# How many standard deviations of Poisson counting noise a cell's change must
# clear before it is treated as birds moving rather than as sampling.
Z_SIGNIFICANT = 2.0
# A week's surface is normalised against this percentile of the whole year,
# not against its own maximum: one roost of twenty thousand would otherwise
# make every other week look empty.
CLIP_PCT = 99.0

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


_NOISE_SCALE = {}


def _noise_scale(g):
    """How much quieter smoothing makes a Poisson field.

    A smoothed cell is a weighted sum of raw counts, so its variance is the
    kernel's sum of squared weights times the local rate - roughly a fortieth
    of the raw variance for this kernel. Testing a smoothed surface against
    raw Poisson noise therefore finds nothing significant anywhere, which is
    precisely what happened. The factor is measured off the kernel rather than
    assumed, by blurring a unit impulse and squaring what comes back.
    """
    key = (g["rows"], g["cols"])
    if key not in _NOISE_SCALE:
        imp = np.zeros(key)
        imp[key[0] // 2, key[1] // 2] = 1.0
        k = _blur(imp, SMOOTH_RADIUS, SMOOTH_PASSES)
        _NOISE_SCALE[key] = float((k ** 2).sum())
    return _NOISE_SCALE[key]


def _haversine(lat1, lon1, lat2, lon2):
    import math
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = (math.sin(dp / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _arcs(a, b, g):
    """Where birds left, and where they turned up.

    Optical flow was the wrong instrument. It fits a smooth, continuous
    velocity field, which is what wind is and what a goose emphatically is
    not: a goose sits on one field for four months and then crosses the
    Atlantic in two days. Worse, Horn-Schunck's smoothness term manufactures
    coherent-looking flow out of sampling noise - measured on this very
    dataset it was two-thirds noise, drawn across open ocean, at the same
    speed in January as in May.

    So this asks a question the data can actually answer. Normalise each week
    so it describes a distribution rather than an amount of birdwatching,
    difference consecutive weeks, and match the cells that lost share to the
    cells that gained it, nearest first. The result is a list of journeys,
    which is the shape migration actually has - and when nothing moves, as in
    midwinter, there is nothing to match and the map goes still.
    """
    sa = a.sum() or 1.0
    sb = b.sum() or 1.0
    if sa < 1 or sb < 1:
        return []
    # Compared at equal effort: b is scaled to a's total, so what is left is a
    # change in where the birds are rather than in how many people were out.
    bs = b * (sa / sb)
    delta = bs - a

    # Counts are Poisson, so the noise in a cell's week-to-week difference is
    # about sqrt(a + b) - and in July, when a whole week is fifty records, that
    # swamps anything real. Testing each cell against its own noise is what
    # stops a summer of breeding geese reading as a mass flight south: the
    # earlier flat threshold could not tell a quiet week from a departure.
    sd = np.sqrt(np.maximum(a + bs, 1e-9) * _noise_scale(g))
    significant = np.abs(delta) > Z_SIGNIFICANT * sd
    delta = np.where(significant, delta, 0.0) / sa

    src, dst = [], []
    for r in range(g["rows"]):
        for c in range(g["cols"]):
            d = delta[r, c]
            if d < -MOVE_FLOOR:
                src.append([-d, r, c])
            elif d > MOVE_FLOOR:
                dst.append([d, r, c])
    if not src or not dst:
        return []

    lat_of = lambda r: g["lat0"] + r * g["dlat"]
    lon_of = lambda c: g["lon0"] + c * g["dlon"]
    src.sort(reverse=True)
    out = []
    for smass, sr, sc in src:
        slat, slon = lat_of(sr), lon_of(sc)
        # Nearest sinks first: a bird leaving the Ouse Washes is far likelier
        # to have gone to the Wash than to Iceland.
        order = sorted(range(len(dst)), key=lambda i: _haversine(
            slat, slon, lat_of(dst[i][1]), lon_of(dst[i][2])))
        for i in order:
            if smass <= 1e-9:
                break
            dmass, dr, dc = dst[i]
            if dmass <= 1e-9:
                continue
            dlat, dlon = lat_of(dr), lon_of(dc)
            km = _haversine(slat, slon, dlat, dlon)
            if km > MAX_HOP_KM:
                continue
            move = min(smass, dmass)
            smass -= move
            dst[i][0] -= move
            if move > MOVE_FLOOR * 0.5:
                out.append([round(slat, 2), round(slon, 2),
                            round(dlat, 2), round(dlon, 2),
                            round(float(move), 5), round(km)])
    out.sort(key=lambda a_: -a_[4])
    return out[:MAX_ARCS]


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

    # Differenced on temporally smoothed surfaces. Week to week, raw counts
    # swing on who happened to go out; a three-week mean is the shortest
    # window in which a change is more likely to be birds than weather.
    k = TEMPORAL_SMOOTH
    smooth = np.stack([stack[max(0, w - k // 2):w + k // 2 + 1].mean(axis=0)
                       for w in range(len(weeks))])

    arcs, ns = [], []
    for w in range(len(weeks)):
        nxt = min(len(weeks) - 1, w + 1)
        arcs.append(_arcs(smooth[w], smooth[nxt], g))
        ns.append(np.round(norm[w], 4).ravel().tolist())

    moved = [sum(a[4] for a in wk) for wk in arcs]
    log.info("arcs per week: median %d, busiest %d (%s)",
             int(np.median([len(a) for a in arcs])),
             max(len(a) for a in arcs),
             weeks[int(np.argmax([len(a) for a in arcs]))].isoformat())
    log.info("share of the population on the move: quietest %.3f, busiest %.3f",
             min(moved), max(moved))

    sci = rows[0][4] or species
    common = _english_name(sci) or species
    payload = {
        "species": {"common": common, "sci": sci},
        "records": len(rows),
        "grid": g,
        "times": [w.isoformat() for w in weeks],
        "n": ns,
        "arcs": arcs,
        "points": points,
        "units": {"points": "observed report positions, [lat,lon,...] per week",
                  "arcs": "[fromLat, fromLon, toLat, toLon, share, km] per week",
                  "n": "reports per cell, smoothed, clipped at the "
                       f"{CLIP_PCT:g}th percentile of the year"},
        "method": "Each week normalised to a distribution, differenced against "
                  "the next, and the cells that lost share matched nearest-first "
                  "to the cells that gained it. Arcs are inferred journeys "
                  "between places, not tracked birds; abundance is reports, so "
                  "it carries observer effort with it.",
        "generated": date.today().isoformat(),
    }
    out = out_path or (WEB_DATA / "migration.json")
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(",", ":")))
    log.info("wrote %s (%.1f MB)", out, out.stat().st_size / 1e6)
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
