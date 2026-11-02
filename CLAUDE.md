# CLAUDE.md — working brief

Notes for whoever picks this up next. `README.md` is the user-facing manual and
is the longer, fuller document; this file is the bit you need before you touch
anything, plus the things that have already gone wrong.

**Keep this file current.** When a rule changes or a trap is found, edit it here
in the same commit.

---

## What this is

A map of bird sightings across Britain and Europe, and — the part under active
development — **an animated migration atlas**: known migration routes, with real
sighting data setting the volume, the timing and the destinations.

- Live: <https://dusky-nembrotha.github.io/uk-bird-map/>
- Repo: `Dusky-Nembrotha/uk-bird-map`, branch `main`; the site is force-pushed
  to `gh-pages` by `./deploy.sh`.

Three views, all served from `web/`:

| Page | What it is |
|---|---|
| `migration.html` + `migration.js` | **A year of migration** — the flock animation. Where most current work happens. |
| `map.html` + `app.js` | The sightings map (Leaflet, clustered points, heat-ramp colouring). |
| `index.html` + `studio.js` | The animation studio for the rolling 30-day data. |

Installable as a PWA: `manifest.webmanifest`, `sw.js`, `pwa.js`, `icons/`
(regenerate the icons with `python3 -m src.icons`).

---

## Charlie's standing instructions

These are not suggestions. They came from him directly and they hold for every
future species and every future change.

1. **Every new species goes through the full test suite before it ships.**
   Known migration route, numbers per country against summer/winter totals,
   directions, everything. `python3 -m src.validate` must pass.
2. **UK sightings must be visible for every species.** This is the whole point
   of the app. A species whose animation never reaches Britain is a bug, even
   if the European picture is right.
3. **Animations are checked against known migration routes, rigorously.**
4. **Routing rules differ by group.** Warblers do not fly like ospreys, which do
   not fly like geese. See `FLIGHT` / `FLIGHT_GROUPS` in `src/migration.py`.
5. **Be honest about abundance.** Marks must never imply more birds than were
   actually seen. A scarce bird must look scarce. Counting *reports* instead of
   *birds* is the recurring way this breaks.
6. **The feel to aim for**: every bird satellite-tagged and tracked — one
   unified flock, arriving at real places. Not flying points layered over a
   separate layer of static sighting dots.

---

## The migration pipeline

Three steps, in order. Steps 2 and 3 are cheap; step 1 is the slow one.

```bash
# 1. Fetch one species' year into data/migration.db
python3 -m src.backfill  --species "Turdus iliacus" --from 2024-09-01 --to 2025-08-31

# 2. Rebuild web/data/migration/<slug>.json for everything in that database
python3 -m src.migration --from 2024-09-01 --to 2025-08-31

# 3. Check it against what the bird actually does. Exits non-zero on FAIL.
python3 -m src.validate
```

**Before a new species can ship it needs two entries written by hand:**

- `SPECIES` in `src/validate.py` — the reference: lat/lon bounds, seasonal
  directions, winter/summer regions, `absent`, `unwatched`, `shift`.
  A species with no entry is reported **SKIP, not PASS**. An unknown bird is not
  a correct one.
- `FLIGHT` in `src/migration.py` — so it gets the right flight group rather than
  silently defaulting to passerine.

### Expect the validator to blame your reference, not the model

This has now happened six times: Bewick's Swan in Romania, Bewick's on the Evros
delta, Short-eared Owl in Iberia, Brent and White-fronted breeding grounds,
Brambling in Denmark. Each time the model was right and the reference I had
written was wrong. Check the ornithology before you change the code.

Two live corrections from recent research, not yet applied to `SPECIES`:
**Red Knot does breed in Svalbard** (>30 pairs; the only Western Palearctic
site), and **Turnstone does not breed in Iceland** (passage migrant plus scarce
winter visitor). See `docs/flyway-reference.md`.

### Why there are two databases

`data/migration.db` is separate from the main database because `fetch_all`
prunes anything older than 30 days, and migration needs whole years.
`src/backfill.py` also **inverts** the live fetcher's rule: it *keeps*
eBird-via-GBIF records.

---

## Traps

Things that have already cost hours.

**GBIF throttles sustained bulk paging.** After several hours of `src.backfill`,
the same query that took 0.58s takes >420s, and restarting does not clear it. It
is not deep offsets, not the geometry polygon, and not our code. Diagnose with
`ps -o pid,etime,time` — 30 seconds of CPU against 6 hours elapsed means waiting
on I/O, not working; `/proc/<pid>/io` rchar delta gives live throughput (healthy
≈ 500 records/sec, throttled ≈ 2–4 KB/sec). The real fix is GBIF's
**occurrence download API** (needs a free GBIF account), which also removes the
`MAX_OFFSET = 100_000` ceiling that currently truncates abundant species
silently. *This is the next piece of work and Charlie has agreed to it.*

**`WORKERS = 1` in `src/backfill.py`, and leave it there.** Six workers stalled
for 1h47m having written one month; serial pulled 70,000 records in 70 seconds.

**`src.backfill` block-buffers stdout to a file.** An empty log is not evidence
of a stall. Also, `$!` after `nohup … &` inside the Bash tool gives the wrapper
shell, not Python — find the real PID with `ps -eo pid,args`.

**Never `pkill -f` a pattern here.** It matches the agent's own shell and kills
the session (exit 144). Kill explicit PIDs.

**Don't deploy twice in quick succession.** `deploy.sh` force-pushes an orphan
commit; doing it repeatedly wedged a Pages deployment and blocked every
subsequent one. The workflow now sets `concurrency: group: pages`, but the
underlying hazard stands.

**Count birds, not records.** 71.6% of records share a coordinate with another;
ten birders logging one flock of 2,000 saw 2,000 birds, not 20,000. The grid
takes the **max** per square per week, not the sum. Getting this wrong once
flipped Pink-footed Goose's autumn movement from +138 km north to −64 km south.

**Observer coverage is not abundance.** Britain has 9,893,729 bird records a
year against Iceland's 214,856 — 46×. Breeding grounds in Arctic Russia and
Svalbard have almost no observers, which is what `unwatched` is for: note the
summer share rather than testing it.

**GBIF has no 2026 data.** 214M eBird records for 2025, zero for 2026 (verified).
Use a complete year that ended before the publication lag — currently
2024-09-01 → 2025-08-31.

**Python, not C.** I have twice written `/* */` comments into `.py` files.

**Canvas performance.** The year map crashed the browser once: 1,137
`createRadialGradient` calls per frame (~70k/sec) plus 3,134 strokes. It now
blits one cached sprite per bird and batches tails into Path2D buckets — about
15 strokes a frame. Don't reintroduce per-frame gradient creation.

**`state.clock`, not wall-clock.** Pause must stop *all* motion; using `now`
left the comets running while the clip was paused.

---

## Everyday commands

```bash
./run.sh                      # fetch, then serve on http://localhost:8777
./run.sh --serve-only
python3 -m src.fetch_all      # all sources, then export
python3 -m src.validate       # the species test suite
python3 -m src.icons          # regenerate PWA icons
./deploy.sh                   # publish web/ to gh-pages
```

The eBird API key lives in `config.json`, which is gitignored. Never commit it.

---

## Where things stand

**Ten species ship and pass** — Pink-footed Goose, Brent Goose, Barnacle Goose,
White-fronted Goose, Waxwing (irruption year 2023–24), Brambling, Osprey,
Bewick's Swan, Short-eared Owl, Yellow-browed Warbler.

**Queued, not yet fetched** (blocked on the GBIF throttle): Redwing, Crane,
Siskin, Hawfinch, Firecrest, Pied Flycatcher. Wood Pigeon (1,136,006 records)
and Blackcap (500,529) are deliberately held back as too large for the current
fetcher.

**Open threads**
- GBIF download API — agreed, not yet built. Needs Charlie's free GBIF account.
- `docs/flyway-reference.md` holds source-backed flyway references and draft
  `SPECIES` entries for **six coastal waders** (Knot, Sanderling, Bar-tailed
  and Black-tailed Godwit, Grey Plover, Turnstone), with conflicts and gaps
  listed. Not yet folded into `SPECIES`, and none of it is validated yet.
  Parallel research on inland/upland waders, aerial feeders and
  wildfowl/raptors was cut off by a session limit and would need redoing.
- eBird Basic Dataset would fix both the 2026 gap and effort bias. Offered, not
  started.
- Aloft/ENRAM CC0 radar data (three new Icelandic radars) — identified, not
  started.
- Natuurpunt: email about the stalled CC0 Flanders dataset (1.7M records/yr).
- **Unanswered design question:** should the published flyway be *authoritative*
  (birds only move along defined corridors; the data sets volume and timing), or
  a *prior* the data is allowed to override? Currently the latter.
