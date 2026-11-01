"""Every check a new species has to pass before it goes on the map.

This exists because each fault in this project was found by eye, late, by
someone noticing something looked wrong - a goose streaming into Spain, a
warbler that appeared to number six, Waxwings absent from a winter they
famously filled. Each one is now a test, so the next species is checked
rather than watched.

Run it after building a species and before deploying:

    python3 -m src.backfill  --species "Turdus iliacus" --from ... --to ...
    python3 -m src.migration --from ... --to ...
    python3 -m src.validate                     # or --species "Turdus iliacus"

It exits non-zero if anything FAILs, so it can gate a release. A species with
no reference encoded is reported SKIP rather than passing quietly: an unknown
bird is not a correct one.
"""
import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import date

from .backfill import DB_PATH
from .config import WEB_DATA

# Boxes are rough on purpose. They are here to tell Iberia from Iceland, not
# to adjudicate a border.
REGIONS = {
    "Iceland":        (62.5, 67.5, -25.0, -12.0),
    "Svalbard":       (74.0, 81.0, 8.0, 35.0),
    "Britain/Ireland": (49.5, 61.2, -11.0, 2.2),
    "Low Countries":  (49.0, 54.0, 2.2, 7.5),
    "Denmark":        (54.0, 58.0, 7.5, 13.5),
    "Norway/Sweden":  (57.5, 71.5, 4.0, 25.0),
    "Finland/Baltic": (53.0, 70.5, 20.0, 32.0),
    "Germany/Poland": (47.0, 55.5, 5.5, 24.5),
    "France":         (42.0, 51.5, -5.5, 8.5),
    "Iberia":         (35.5, 44.0, -10.0, 3.5),
    "Mediterranean":  (33.0, 46.0, 3.5, 30.0),
    "Arctic Russia":  (66.0, 78.0, 32.0, 60.0),
}

AUTUMN, WINTER, SPRING, SUMMER = (9, 10, 11), (12, 1, 2), (3, 4, 5), (6, 7, 8)

# Per species: where it should be, where it should not, and which way it goes.
#   lat/lon     the flyway's bounds
#   autumn/spring  "n", "s" or "-" for no expectation
#   winter      regions that should hold most of it in midwinter
#   summer      regions it should be in when breeding
#   absent      regions it has no business in
#   shift       least degrees of latitude between summer and winter centroids
SPECIES = {
    "Anser brachyrhynchus": dict(
        name="Pink-footed Goose", lat=(49, 81), lon=(-28, 32),
        autumn="s", spring="n",
        winter=["Britain/Ireland", "Denmark", "Low Countries"],
        summer=["Iceland", "Svalbard", "Norway/Sweden"],
        absent=["Iberia", "Mediterranean"], shift=3.0,
        note="Iceland and Greenland to Britain; Svalbard to Norway, Denmark "
             "and the Low Countries. Nothing south of Belgium."),
    "Anser albifrons": dict(
        name="White-fronted Goose", lat=(40, 81), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Britain/Ireland", "Low Countries", "Germany/Poland"],
        summer=["Arctic Russia", "Iceland", "Norway/Sweden"],
        unwatched=["Arctic Russia", "Svalbard"],
        absent=["Iberia"], shift=2.0,
        note="Russian and Greenland arctic to NW Europe and the Pannonian "
             "basin."),
    "Branta leucopsis": dict(
        name="Barnacle Goose", lat=(49, 81), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Britain/Ireland", "Low Countries", "Germany/Poland",
                "Denmark"],
        summer=["Svalbard", "Arctic Russia", "Norway/Sweden",
                "Finland/Baltic"],
        unwatched=["Arctic Russia", "Svalbard"],
        absent=["Iberia", "Mediterranean"], shift=1.5,
        note="Greenland, Svalbard and the Russian arctic to the Solway, "
             "Ireland, the Wadden Sea and the Baltic."),
    "Branta bernicla": dict(
        name="Brent Goose", lat=(41, 81), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Britain/Ireland", "Low Countries", "France", "Denmark"],
        summer=["Arctic Russia", "Svalbard"],
        unwatched=["Arctic Russia", "Svalbard"],
        absent=["Mediterranean"], shift=2.0,
        note="Arctic Russia and Svalbard to NW European coasts; some reach "
             "western France."),
    "Cygnus columbianus": dict(
        name="Bewick's Swan", lat=(39, 78), lon=(-12, 45),
        autumn="s", spring="n",
        winter=["Britain/Ireland", "Low Countries", "Germany/Poland",
                "Denmark", "Mediterranean"],
        summer=["Arctic Russia"], unwatched=["Arctic Russia"],
        absent=["Iberia"], shift=2.0,
        note="Russian arctic to Britain, the Netherlands and Germany, and a "
             "separate eastern population to the Black Sea, the Evros delta "
             "and the Caspian - which is a third of the birds and was missing "
             "from the first version of this list."),
    "Cygnus cygnus": dict(
        name="Whooper Swan", lat=(45, 78), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Britain/Ireland", "Denmark", "Germany/Poland"],
        summer=["Iceland", "Finland/Baltic", "Norway/Sweden", "Arctic Russia"],
        unwatched=["Arctic Russia", "Svalbard"],
        absent=["Iberia"], shift=2.0,
        note="Iceland to Britain and Ireland; Fennoscandia and Russia to the "
             "Baltic and the Low Countries."),
    "Pandion haliaetus": dict(
        name="Osprey", lat=(33, 72), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Iberia", "Mediterranean", "France"],
        summer=["Britain/Ireland", "Norway/Sweden", "Finland/Baltic",
                "Germany/Poland"],
        absent=["Svalbard"], shift=4.0,
        note="Breeds northern Europe, winters West Africa - so the autumn "
             "exit runs off the south edge of the window."),
    "Asio flammeus": dict(
        name="Short-eared Owl", lat=(35, 75), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Britain/Ireland", "France", "Low Countries", "Iberia",
                "Denmark"],
        summer=["Norway/Sweden", "Finland/Baltic", "Britain/Ireland"],
        absent=["Svalbard"], shift=1.0,
        note="Partial migrant; northern breeders move south and west. The "
             "first reference here omitted Iberia and failed the species for "
             "wintering there, which it does."),
    "Phylloscopus inornatus": dict(
        name="Yellow-browed Warbler", lat=(35, 72), lon=(-28, 45),
        autumn="-", spring="-",
        winter=["Iberia", "Britain/Ireland", "France"],
        summer=[], absent=["Svalbard"], shift=0.0,
        note="Siberian breeder; in this window a scarce autumn passage bird "
             "moving south and west. The breeding grounds are off the map, "
             "so no seasonal reversal is expected."),
    "Bombycilla garrulus": dict(
        name="Waxwing", lat=(43, 72), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Norway/Sweden", "Finland/Baltic", "Germany/Poland",
                "Britain/Ireland", "Denmark"],
        summer=["Norway/Sweden", "Finland/Baltic", "Arctic Russia"],
        absent=["Iberia"], shift=1.0,
        note="Fennoscandian and Russian breeder, irruptive south and west in "
             "winter. Irruption years reach Britain in thousands; quiet years "
             "barely at all, so the window matters more than for most."),
    "Fringilla montifringilla": dict(
        name="Brambling", lat=(35, 72), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Germany/Poland", "France", "Britain/Ireland",
                "Low Countries", "Denmark", "Norway/Sweden"],
        summer=["Norway/Sweden", "Finland/Baltic"],
        absent=["Svalbard"], shift=3.0,
        note="Fennoscandian breeder wintering across Europe; numbers swing "
             "with the beech mast."),
    "Turdus iliacus": dict(
        name="Redwing", lat=(35, 72), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Britain/Ireland", "France", "Iberia", "Low Countries"],
        summer=["Iceland", "Norway/Sweden", "Finland/Baltic"],
        absent=["Svalbard"], shift=3.0,
        note="Iceland and Fennoscandia to Britain, Ireland and southern "
             "Europe."),
    "Turdus pilaris": dict(
        name="Fieldfare", lat=(35, 72), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Britain/Ireland", "France", "Germany/Poland"],
        summer=["Norway/Sweden", "Finland/Baltic"],
        absent=["Svalbard"], shift=2.5,
        note="Fennoscandian and Russian breeder wintering across western and "
             "southern Europe."),
    "Grus grus": dict(
        name="Crane", lat=(33, 70), lon=(-12, 45),
        autumn="s", spring="n",
        winter=["Iberia", "France", "Mediterranean"],
        summer=["Norway/Sweden", "Finland/Baltic", "Germany/Poland"],
        absent=["Svalbard", "Iceland"], shift=4.0,
        note="Fennoscandia and the Baltic to Iberia and North Africa on "
             "narrow, well-known corridors."),
    "Regulus ignicapilla": dict(
        name="Firecrest", lat=(33, 62), lon=(-12, 45),
        autumn="s", spring="n",
        winter=["Iberia", "France", "Britain/Ireland"],
        summer=["France", "Germany/Poland"],
        absent=["Svalbard", "Iceland"], shift=0.5,
        note="Short-distance migrant; northern birds move south and west."),
    "Ficedula hypoleuca": dict(
        name="Pied Flycatcher", lat=(33, 72), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Iberia"], summer=["Norway/Sweden", "Finland/Baltic",
                                   "Britain/Ireland", "Germany/Poland"],
        absent=["Svalbard"], shift=3.0,
        note="Breeds northern Europe, winters West Africa - the autumn exit "
             "leaves the window southward through Iberia."),
    "Coccothraustes coccothraustes": dict(
        name="Hawfinch", lat=(35, 68), lon=(-12, 45),
        autumn="-", spring="-",
        winter=["Germany/Poland", "France"],
        summer=["Germany/Poland", "France"],
        absent=["Svalbard", "Iceland"], shift=0.0,
        note="Largely resident in the west with northern birds moving; no "
             "strong seasonal reversal expected."),
    "Spinus spinus": dict(
        name="Siskin", lat=(33, 72), lon=(-28, 45),
        autumn="-", spring="-",
        winter=["Britain/Ireland", "France", "Germany/Poland"],
        summer=["Norway/Sweden", "Finland/Baltic", "Britain/Ireland"],
        absent=["Svalbard"], shift=0.0,
        note="Irruptive and irregular; direction varies year to year."),
    "Oenanthe oenanthe": dict(
        name="Wheatear", lat=(33, 80), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Iberia", "Mediterranean"],
        summer=["Britain/Ireland", "Norway/Sweden", "Iceland",
                "Finland/Baltic"],
        absent=[], shift=3.0,
        note="Breeds from Iberia to the high arctic, winters in the Sahel - "
             "the autumn exit leaves the window southward."),
    "Sylvia atricapilla": dict(
        name="Blackcap", lat=(33, 68), lon=(-28, 45),
        autumn="s", spring="n",
        winter=["Iberia", "Britain/Ireland", "France", "Mediterranean"],
        summer=["Germany/Poland", "France", "Britain/Ireland"],
        absent=["Svalbard"], shift=1.0,
        note="Central European breeders winter in Iberia; a growing number "
             "now winter in Britain instead."),
    "Columba palumbus": dict(
        name="Wood Pigeon", lat=(33, 70), lon=(-12, 45),
        autumn="s", spring="n",
        winter=["France", "Iberia", "Britain/Ireland"],
        summer=["Britain/Ireland", "Germany/Poland", "Norway/Sweden"],
        absent=["Svalbard", "Iceland"], shift=1.0,
        note="Resident in the west; northern and eastern birds make a heavy, "
             "visible autumn passage into France and Iberia."),
}

STRAY_TOLERANCE = 0.02          # journeys allowed outside the flyway
ABSENT_TOLERANCE = 0.01         # birds allowed in a region it should not use
WINTER_SHARE = 0.55             # of midwinter birds in expected regions
# This is a British bird map. A species the reference says occurs here must
# actually appear here, through the season it is supposed to.
#
# Tested on presence, not share. A single Danish roost held a million
# Bramblings in January 2025 - a real count, at Artoft Plantage - which makes
# Britain's perfectly healthy nine thousand into 0.12% of the species and
# failed it on a share threshold. What matters is whether the bird is here
# across the season, not whether Britain holds a large fraction of Europe.
UK_MIN_BIRDS = 50
UK_MIN_WEEKS = 4
UK_LOW_SHARE = 0.002


def _region(lat, lon):
    for name, (s, n, w, e) in REGIONS.items():
        if s <= lat <= n and w <= lon <= e:
            return name
    return "other"


def _months(times, months):
    return [i for i, t in enumerate(times)
            if date.fromisoformat(t).month in months]


def _points(d, idx):
    out = []
    for w in idx:
        arr = d["points"][w]
        for k in range(0, len(arr), 3):
            out.append((arr[k], arr[k + 1], arr[k + 2]))
    return out


def validate(path):
    d = json.loads(path.read_text())
    sci = d["species"]["sci"].split(" (")[0].strip()
    name = d["species"]["common"]
    ref = next((r for s, r in SPECIES.items()
                if sci.lower().startswith(s.lower())), None)
    if not ref:
        return name, [("SKIP", f"no reference encoded for {sci} - add one to "
                               f"src/validate.py before shipping it")], 0
    res = []
    lo, hi = ref["lat"]
    wlo, whi = ref["lon"]

    # 1. The window actually covers what it claims.
    span = d.get("span", {})
    if span.get("complete") is False:
        res.append(("WARN", f"part year only: {span.get('from')} to "
                            f"{span.get('to')} - the clip says so, but a "
                            f"species cut off mid-migration is the wrong clip "
                            f"to show"))
    else:
        res.append(("PASS", f"full window {span.get('from')} to {span.get('to')}"))

    # 2. Flight rules assigned rather than defaulted silently.
    fl = d.get("flight", {})
    if not fl.get("group"):
        res.append(("WARN", "no flight group - routes will use the default"))
    else:
        res.append(("INFO", f"flight group '{fl['group']}', water costs "
                            f"{fl.get('sea')}x land"))

    # 3. Journeys stay inside the flyway.
    arcs = [a for wk in d["arcs"] for a in wk]
    if not arcs:
        res.append(("FAIL", "no modelled movement at all"))
    else:
        stray = [a for a in arcs
                 if not (lo <= a[0] <= hi and lo <= a[2] <= hi
                         and wlo <= a[1] <= whi and wlo <= a[3] <= whi)]
        share = len(stray) / len(arcs)
        if not stray:
            res.append(("PASS", f"all {len(arcs):,} journeys inside the flyway"))
        elif share <= STRAY_TOLERANCE:
            res.append(("WARN", f"{len(stray)} of {len(arcs):,} journeys "
                                f"({share * 100:.1f}%) outside - within the "
                                f"{STRAY_TOLERANCE * 100:.0f}% expected from "
                                f"stray records"))
        else:
            worst = max(stray, key=lambda a: a[4])
            res.append(("FAIL", f"{len(stray)} of {len(arcs):,} journeys "
                                f"({share * 100:.1f}%) outside the flyway, "
                                f"worst {worst[0]:.1f}N {worst[1]:.1f}E -> "
                                f"{worst[2]:.1f}N {worst[3]:.1f}E"))

    # 4. Seasonal direction.
    for label, months, want in (("autumn", AUTUMN, ref["autumn"]),
                                ("spring", SPRING, ref["spring"])):
        sel = [a for w in _months(d["times"], months) for a in d["arcs"][w]]
        if not sel:
            res.append(("WARN", f"{label}: no modelled movement to check"))
            continue
        tot = sum(a[4] for a in sel) or 1e-9
        net = sum((a[2] - a[0]) * 111 * a[4] for a in sel) / tot
        got = "n" if net > 25 else "s" if net < -25 else "-"
        if want == "-":
            res.append(("INFO", f"{label}: net {net:+.0f} km (no expectation)"))
        elif got == want:
            res.append(("PASS", f"{label}: net {net:+.0f} km, "
                                f"{'north' if want == 'n' else 'south'}"))
        else:
            res.append(("FAIL", f"{label}: net {net:+.0f} km, expected "
                                f"{'north' if want == 'n' else 'south'}"))

    # 5. Summer and winter in the right places, and the shift between them.
    for label, months, expect in (("winter", WINTER, ref["winter"]),
                                  ("summer", SUMMER, ref["summer"])):
        idx = _months(d["times"], months)
        # A window ending in February contains three stray August weeks, and
        # testing "summer" against those is a test of nothing.
        if len(idx) < 8:
            res.append(("WARN", f"{label}: only {len(idx)} weeks in the "
                                f"window - not enough to test"))
            continue
        pts = _points(d, idx)
        birds = sum(p[2] for p in pts)
        if not birds:
            res.append(("WARN", f"{label}: no birds recorded at all"))
            continue
        by = defaultdict(float)
        for lat, lon, n in pts:
            by[_region(lat, lon)] += n
        top = sorted(by.items(), key=lambda kv: -kv[1])[:3]
        unwatched = set(ref.get("unwatched", []))
        if expect and set(expect) & unwatched:
            # The Siberian tundra has no birders on it. Asserting a share
            # there tests observer coverage, not the bird - the seasonal
            # latitude shift below is the honest test for these species.
            got = sum(by[r] for r in expect) / birds
            res.append(("INFO", f"{label}: {got * 100:.0f}% in "
                                f"{'/'.join(expect)} - breeding grounds are "
                                f"unwatched, so this is noted not tested "
                                f"(top: {', '.join(f'{r} {v / birds * 100:.0f}%' for r, v in top)})"))
        elif expect:
            got = sum(by[r] for r in expect) / birds
            tag = "PASS" if got >= WINTER_SHARE else "FAIL"
            res.append((tag, f"{label}: {got * 100:.0f}% of birds in "
                             f"{'/'.join(expect)} "
                             f"(top: {', '.join(f'{r} {v / birds * 100:.0f}%' for r, v in top)})"))
        else:
            res.append(("INFO", f"{label}: top regions "
                                f"{', '.join(f'{r} {v / birds * 100:.0f}%' for r, v in top)}"))

    wpts, spts = (_points(d, _months(d["times"], WINTER)),
                  _points(d, _months(d["times"], SUMMER)))
    if wpts and spts and ref["shift"] > 0:
        wlat = sum(p[0] * p[2] for p in wpts) / sum(p[2] for p in wpts)
        slat = sum(p[0] * p[2] for p in spts) / sum(p[2] for p in spts)
        d_lat = slat - wlat
        tag = "PASS" if d_lat >= ref["shift"] else "FAIL"
        res.append((tag, f"seasonal shift: winter {wlat:.1f}N, summer "
                         f"{slat:.1f}N, {d_lat:+.1f} deg "
                         f"(expected at least +{ref['shift']})"))

    # 6. Not where it has no business being.
    allpts = _points(d, range(len(d["points"])))
    total = sum(p[2] for p in allpts) or 1
    for bad in ref["absent"]:
        s, n, w, e = REGIONS[bad]
        got = sum(p[2] for p in allpts if s <= p[0] <= n and w <= p[1] <= e)
        if got / total > ABSENT_TOLERANCE:
            res.append(("FAIL", f"{got:,} birds ({got / total * 100:.1f}%) in "
                                f"{bad}, where it should not occur"))
    if ref["absent"]:
        res.append(("PASS" if all(l != "FAIL" or bad not in m
                                  for l, m in res for bad in ref["absent"])
                    else "INFO",
                    f"checked against {len(ref['absent'])} region(s) it should "
                    f"not use"))

    # 7. It has to show up in Britain, which is the point of the map.
    uk_seasons = [lab for lab, exp in (("winter", ref["winter"]),
                                       ("summer", ref["summer"]))
                  if "Britain/Ireland" in exp]
    s_lat, n_lat, w_lon, e_lon = REGIONS["Britain/Ireland"]
    uk_all = [p for p in allpts
              if s_lat <= p[0] <= n_lat and w_lon <= p[1] <= e_lon]
    uk_birds = sum(p[2] for p in uk_all)
    if not uk_seasons:
        res.append(("INFO", f"not expected in Britain; {uk_birds:,} birds "
                            f"recorded here anyway"))
    else:
        peak, weeks_here = 0, 0
        for w in range(len(d["points"])):
            arr = d["points"][w]
            wk = sum(arr[k + 2] for k in range(0, len(arr), 3)
                     if s_lat <= arr[k] <= n_lat and w_lon <= arr[k + 1] <= e_lon)
            if wk:
                weeks_here += 1
            peak = max(peak, wk)
        if uk_birds < UK_MIN_BIRDS or weeks_here < UK_MIN_WEEKS:
            res.append(("FAIL", f"only {uk_birds:,} birds in Britain and "
                                f"Ireland across {weeks_here} weeks - the "
                                f"reference says it should be here in "
                                f"{' and '.join(uk_seasons)}. Either the "
                                f"window stops before it arrives, or the data "
                                f"is wrong"))
        else:
            share = uk_birds / total
            res.append(("PASS", f"Britain and Ireland: {uk_birds:,} birds "
                                f"across {weeks_here} weeks, peak week "
                                f"{peak:,} ({share * 100:.1f}% of the "
                                f"European total)"))
            if share < UK_LOW_SHARE:
                res.append(("INFO", "Britain is a small share of this "
                                    "species, which for a bird with "
                                    "continental roosts is expected"))

    # 8. How much of the map is guesswork between counts.
    weeks = len(d["points"])
    squares = {(p[0], p[1]) for p in allpts}
    seen = sum(1 for w in range(weeks)
               for k in range(0, len(d["points"][w]), 3))
    if squares and weeks:
        cover = seen / (len(squares) * weeks)
        tag = "WARN" if cover < 0.15 else "INFO"
        res.append((tag, f"site-week coverage {cover * 100:.0f}% - the rest is "
                         f"interpolated between counts"))

    # 8. Is this a representative year for an irruptive species?
    res.append(("INFO", f"{d['records']:,} reports, peak week "
                        f"{max(d.get('weekBirds') or [0]):,} birds"))

    fails = sum(1 for lvl, _ in res if lvl == "FAIL")
    return name, res, fails


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--species", help="common or scientific name")
    a = ap.parse_args()
    files = sorted(f for f in (WEB_DATA / "migration").glob("*.json")
                   if f.name != "index.json")
    if not files:
        raise SystemExit("Nothing built. Run python3 -m src.migration first.")

    total = 0
    shown = 0
    for f in files:
        name, res, fails = validate(f)
        hay = (name + " " + f.stem).lower().replace("-", " ")
        if a.species and a.species.lower().replace("-", " ") not in hay:
            continue
        shown += 1
        total += fails
        print(f"\n{name}")
        for lvl, msg in res:
            print(f"  [{lvl}] {msg}")
    if not shown:
        raise SystemExit(f"No built species matched {a.species!r}")
    print(f"\n{'FAILURES: ' + str(total) if total else 'All checks passed.'}")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
