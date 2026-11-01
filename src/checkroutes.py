"""Check each built migration model against the species' known flyway.

Added because a Pink-footed Goose animation was shipped showing a dense
southward stream across France and the Mediterranean - a flyway this bird does
not have. The model was innocent; the renderer drew it. Nobody checked,
because checking meant watching forty seconds of animation and knowing what to
look for.

This encodes what is known about each species and tests the built file against
it. The expectations below are from the standard accounts (Wetlands
International flyway atlases, BTO/BirdLife range descriptions); they are
deliberately loose, because the point is to catch a goose over Madrid, not to
quibble over a degree.

    python3 -m src.checkroutes            # every built species
    python3 -m src.checkroutes --species "Anser brachyrhynchus"
"""
import argparse
import json
import sys

from .config import WEB_DATA

# lat/lon bounds the species should keep to, and which way it should be going
# in autumn and spring. "n" north, "s" south, "-" no strong expectation.
FLYWAYS = {
    "Anser brachyrhynchus": {
        "name": "Pink-footed Goose",
        "lat": (49, 81), "lon": (-28, 32), "autumn": "s", "spring": "n",
        "note": "Iceland/Greenland to Britain; Svalbard to Norway, Denmark, "
                "the Netherlands and Belgium. Nothing south of the Low "
                "Countries.",
    },
    "Branta leucopsis": {
        "name": "Barnacle Goose", "lat": (49, 81), "lon": (-28, 45),
        "autumn": "s", "spring": "n",
        "note": "Greenland/Svalbard/Russian arctic to the Solway, Ireland, "
                "the Wadden Sea and the Baltic.",
    },
    "Branta bernicla": {
        "name": "Brent Goose", "lat": (43, 81), "lon": (-28, 45),
        "autumn": "s", "spring": "n",
        "note": "Arctic Russia and Svalbard to NW European coasts; some "
                "reach western France.",
    },
    "Anser albifrons": {
        "name": "White-fronted Goose", "lat": (40, 81), "lon": (-28, 45),
        "autumn": "s", "spring": "n",
        "note": "Russian and Greenland arctic to NW Europe and the Pannonian "
                "basin.",
    },
    "Cygnus columbianus": {
        "name": "Bewick's Swan", "lat": (39, 78), "lon": (-12, 45),
        "autumn": "s", "spring": "n",
        "note": "Russian arctic to Britain, the Netherlands and Germany, and "
                "a separate eastern population to the Black Sea, the Evros "
                "delta on the Greek-Turkish border and the Caspian. This "
                "bound was wrong twice: 48N failed a third of the journeys "
                "for being in Romania, and 41N still failed the Evros birds, "
                "which run to flocks of four thousand. The check is only as "
                "good as what is encoded here, and twice it caught the "
                "reference rather than the model.",
    },
    "Phylloscopus inornatus": {
        "name": "Yellow-browed Warbler", "lat": (35, 72), "lon": (-28, 45),
        "autumn": "-", "spring": "-",
        "note": "Siberian breeder; in this window a scarce autumn passage "
                "bird moving broadly south and west. The breeding grounds are "
                "off the map, so no clean seasonal reversal is expected.",
    },
    "Bombycilla garrulus": {
        "name": "Waxwing", "lat": (43, 72), "lon": (-28, 45),
        "autumn": "s", "spring": "n",
        "note": "Fennoscandian and Russian breeder, irruptive south and west "
                "in winter. Irruption years travel much further than others.",
    },
    "Pandion haliaetus": {
        "name": "Osprey", "lat": (33, 72), "lon": (-28, 45),
        "autumn": "s", "spring": "n",
        "note": "Breeds northern Europe, winters West Africa - so the autumn "
                "exit runs off the south edge of the window.",
    },
    "Asio flammeus": {
        "name": "Short-eared Owl", "lat": (35, 75), "lon": (-28, 45),
        "autumn": "s", "spring": "n",
        "note": "Partial migrant; northern breeders move south and west.",
    },
    "Fringilla montifringilla": {
        "name": "Brambling", "lat": (35, 72), "lon": (-28, 45),
        "autumn": "s", "spring": "n",
        "note": "Fennoscandian breeder wintering across Europe; numbers swing "
                "with the beech mast.",
    },
    "Turdus iliacus": {
        "name": "Redwing", "lat": (35, 72), "lon": (-28, 45),
        "autumn": "s", "spring": "n",
        "note": "Iceland and Fennoscandia to Britain, Ireland and southern "
                "Europe.",
    },
    "Grus grus": {
        "name": "Crane", "lat": (33, 70), "lon": (-12, 45),
        "autumn": "s", "spring": "n",
        "note": "Fennoscandia and the Baltic to Iberia and North Africa on "
                "narrow, well-known corridors.",
    },
    "Coccothraustes coccothraustes": {
        "name": "Hawfinch", "lat": (35, 68), "lon": (-12, 45),
        "autumn": "-", "spring": "-",
        "note": "Largely resident in the west with northern birds moving; no "
                "strong seasonal reversal expected.",
    },
    "Regulus ignicapilla": {
        "name": "Firecrest", "lat": (33, 62), "lon": (-12, 45),
        "autumn": "s", "spring": "n",
        "note": "Short-distance migrant; northern birds move south and west.",
    },
    "Ficedula hypoleuca": {
        "name": "Pied Flycatcher", "lat": (33, 72), "lon": (-28, 45),
        "autumn": "s", "spring": "n",
        "note": "Breeds northern Europe, winters West Africa - the autumn "
                "exit leaves the window southward.",
    },
    "Spinus spinus": {
        "name": "Siskin", "lat": (33, 72), "lon": (-28, 45),
        "autumn": "-", "spring": "-",
        "note": "Irruptive and irregular; direction varies year to year.",
    },
}

# Share of journeys allowed outside the known range before it is a fault.
STRAY_TOLERANCE = 0.02

AUTUMN = (9, 10, 11)
SPRING = (3, 4, 5)


def _season(times, months):
    import datetime
    return [i for i, t in enumerate(times)
            if datetime.date.fromisoformat(t).month in months]


def check(path):
    d = json.loads(path.read_text())
    sci = d["species"]["sci"].split(" (")[0].strip()
    ref = FLYWAYS.get(sci)
    name = d["species"]["common"]
    out = []
    if not ref:
        return name, [("SKIP", f"no flyway reference encoded for {sci}")], 0

    lo, hi = ref["lat"]
    wlo, whi = ref["lon"]

    # 1. Journeys must stay inside the species' range.
    arcs = [a for wk in d["arcs"] for a in wk]
    stray = [a for a in arcs
             if not (lo <= a[0] <= hi and lo <= a[2] <= hi
                     and wlo <= a[1] <= whi and wlo <= a[3] <= whi)]
    if arcs:
        share = len(stray) / len(arcs)
        if not stray:
            out.append(("PASS", f"all {len(arcs)} journeys inside "
                                f"{lo}-{hi}N, {wlo}-{whi}E"))
        elif share <= STRAY_TOLERANCE:
            # Citizen records carry vagrants, escapes and the occasional
            # mis-identification, and a transport model will join a few of
            # them to something real. A handful is the cost of the data; a
            # sustained stream is a fault.
            out.append(("WARN", f"{len(stray)} of {len(arcs)} journeys "
                                f"({share * 100:.1f}%) leave the known range - "
                                f"within the {STRAY_TOLERANCE * 100:.0f}% "
                                f"expected from stray records"))
        else:
            worst = max(stray, key=lambda a: a[4])
            out.append(("FAIL", f"{len(stray)} of {len(arcs)} journeys "
                                f"({share * 100:.1f}%) leave the known range, "
                                f"worst {worst[0]:.1f}N {worst[1]:.1f}E -> "
                                f"{worst[2]:.1f}N {worst[3]:.1f}E"))
    else:
        out.append(("WARN", "no journeys in the model at all"))

    # 2. Seasonal direction, weighted by how much of the population moved.
    for season, months, want in (("autumn", AUTUMN, ref["autumn"]),
                                 ("spring", SPRING, ref["spring"])):
        idx = _season(d["times"], months)
        sel = [a for w in idx for a in d["arcs"][w]]
        if not sel:
            out.append(("WARN", f"{season}: no modelled movement to check"))
            continue
        tot = sum(a[4] for a in sel) or 1e-9
        net = sum((a[2] - a[0]) * 111 * a[4] for a in sel) / tot
        got = "n" if net > 25 else "s" if net < -25 else "-"
        if want == "-":
            out.append(("INFO", f"{season}: net {net:+.0f} km "
                                f"(no expectation set)"))
        elif got == want:
            out.append(("PASS", f"{season}: net {net:+.0f} km, "
                                f"{'north' if want == 'n' else 'south'} as expected"))
        else:
            out.append(("FAIL", f"{season}: net {net:+.0f} km, expected "
                                f"{'north' if want == 'n' else 'south'}"))

    # 3. Reports outside the range are data noise - vagrants, escapes,
    #    mis-identifications - and are worth knowing about but not failing on.
    pts = [(d["points"][w][k], d["points"][w][k + 1], d["points"][w][k + 2])
           for w in range(len(d["points"]))
           for k in range(0, len(d["points"][w]), 3)]
    outside = [p for p in pts if not (lo <= p[0] <= hi and wlo <= p[1] <= whi)]
    if pts:
        birds = sum(p[2] for p in outside)
        total = sum(p[2] for p in pts) or 1
        tag = "WARN" if birds / total > 0.01 else "INFO"
        out.append((tag, f"{len(outside)} of {len(pts):,} reported squares "
                         f"outside the range ({birds:,} birds, "
                         f"{birds / total * 100:.2f}%)"))

    fails = sum(1 for lvl, _ in out if lvl == "FAIL")
    return name, out, fails


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--species", help="scientific name; default is all built")
    a = ap.parse_args()

    files = sorted((WEB_DATA / "migration").glob("*.json"))
    files = [f for f in files if f.name != "index.json"]
    if not files:
        raise SystemExit("No built migration files. Run python3 -m src.migration")

    total_fail = 0
    for f in files:
        name, results, fails = check(f)
        if a.species and a.species.lower() not in (name.lower() + f.stem):
            continue
        total_fail += fails
        print(f"\n{name}")
        for lvl, msg in results:
            print(f"  [{lvl}] {msg}")
        ref = next((r for s, r in FLYWAYS.items()
                    if r["name"] == name), None)
        if ref:
            print(f"  ref: {ref['note']}")
    print(f"\n{'FAILURES: ' + str(total_fail) if total_fail else 'All checks passed.'}")
    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main())
